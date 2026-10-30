import { resolve } from "node:path";
import { readdir, unlink, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { RunInstance } from "#shared";
import { runDir, runFilePath, logFilePath, worktreeDir } from "./paths";
import { dockerRemove, dockerPs } from "./containers";

export interface RunState {
  project: string;
  slug: string;
  branch: string;
  port: number | null;
  pid: number | null;
  container: string | null;
  started: number;
  /** the host instance runs in its own process group (kill -- -PGID on stop). */
  pgroup: boolean;
}

const toNum = (v: string | undefined): number | null => {
  if (v === undefined || v === "") return null;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};

/** Parse a `.run` file (k=v lines). null if the file is missing. Parity with read_run(). */
export async function parseRunState(file: string): Promise<RunState | null> {
  const f = Bun.file(file);
  if (!(await f.exists())) return null;
  const kv: Record<string, string> = {};
  for (const line of (await f.text()).split("\n")) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    kv[line.slice(0, i)] = line.slice(i + 1);
  }
  return {
    project: kv.project ?? "",
    slug: kv.slug ?? "",
    branch: kv.branch ?? "",
    port: toNum(kv.port),
    pid: toNum(kv.pid),
    container: kv.container ? kv.container : null,
    started: toNum(kv.started) ?? 0,
    pgroup: kv.pgroup === "1",
  };
}

export interface RunStateWrite {
  project: string;
  slug: string;
  branch: string;
  port: number;
  started: number;
  container?: string | null;
  pid?: number | null;
  pgroup?: boolean;
}

/** Contents of a `.run` file. Parity with the `{ echo … } > rf` blocks in cmd_start (key order matters). */
export function formatRunState(rs: RunStateWrite): string {
  const lines = rs.container
    ? [`container=${rs.container}`, `port=${rs.port}`, `branch=${rs.branch}`, `started=${rs.started}`, `project=${rs.project}`, `slug=${rs.slug}`]
    : [`pid=${rs.pid}`, `port=${rs.port}`, `branch=${rs.branch}`, `started=${rs.started}`, `project=${rs.project}`, `slug=${rs.slug}`];
  if (!rs.container && rs.pgroup) lines.push("pgroup=1");
  return lines.join("\n") + "\n";
}

export type StopAction =
  | { kind: "container"; container: string }
  | { kind: "pid"; pid: number; pgroup: boolean }
  | { kind: "cleanup" };

/**
 * What to do on `wt stop`: a container (docker rm -f, always), or a live host pid
 * (kill_tree), or just clean up the runfile. Parity with cmd_stop.
 */
export function stopDecision(rs: RunState, alive: boolean): StopAction {
  if (rs.container) return { kind: "container", container: rs.container };
  if (rs.pid !== null && alive) return { kind: "pid", pid: rs.pid, pgroup: rs.pgroup };
  return { kind: "cleanup" };
}

export interface AliveProbes {
  dockerRunning: (container: string) => Promise<boolean>;
  pidAlive: (pid: number) => boolean;
}

/** Whether the instance is alive: container → docker, otherwise pid. Parity with inst_alive(). */
export async function isInstanceAlive(rs: RunState, probes: AliveProbes): Promise<boolean> {
  if (rs.container) return probes.dockerRunning(rs.container);
  if (rs.pid !== null) return probes.pidAlive(rs.pid);
  return false;
}

export const defaultProbes: AliveProbes = {
  dockerRunning: async (c) => {
    const proc = Bun.spawn(["docker", "inspect", "-f", "{{.State.Running}}", c], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return out === "true";
  },
  pidAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
};

/** Live instances from `<orch>/var/run/*.run`. Parity with `wt ps --json`. */
export async function listRunningInstances(
  orch: string,
  probes: AliveProbes = defaultProbes,
): Promise<RunInstance[]> {
  const dir = runDir(orch);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".run"));
  } catch {
    return [];
  }
  const out: RunInstance[] = [];
  for (const file of files.sort()) {
    const rs = await parseRunState(resolve(dir, file));
    if (!rs) continue;
    if (!(await isInstanceAlive(rs, probes))) continue;
    out.push({
      project: rs.project,
      slug: rs.slug,
      branch: rs.branch,
      port: rs.port,
      pid: rs.pid,
      container: rs.container,
      started: rs.started,
      alive: true,
    });
  }
  return out;
}

export interface StopActions {
  /** docker rm -f <container> (no-op if not running); throws if the container is still there. */
  dockerRm: (container: string) => Promise<void>;
  /** kill_tree: pgroup → TERM to the group, 10s, then KILL; otherwise TERM to the process. */
  killTree: (pid: number, pgroup: boolean) => Promise<void>;
}

const defaultStopActions: StopActions = {
  dockerRm: (c) => dockerRemove([c]),
  killTree: async (pid, pgroup) => {
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    if (!pgroup) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
      return;
    }
    try {
      process.kill(-pid, "SIGTERM");
    } catch {}
    for (let i = 0; i < 20 && alive(); i++) await Bun.sleep(500);
    if (alive()) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }
  },
};

export interface StopOutcome {
  project: string;
  slug: string;
  action: StopAction["kind"];
  container: string | null;
  pid: number | null;
  /** Failure reason; null — the instance is down. On error the runfile is NOT removed. */
  error: string | null;
}

async function applyStop(file: string, probes: AliveProbes, actions: StopActions): Promise<StopOutcome | null> {
  const rs = await parseRunState(file);
  if (!rs) return null;
  const decision = stopDecision(rs, await isInstanceAlive(rs, probes));
  const base = { project: rs.project, slug: rs.slug, action: decision.kind, container: rs.container, pid: rs.pid };
  try {
    if (decision.kind === "container") await actions.dockerRm(decision.container);
    else if (decision.kind === "pid") await actions.killTree(decision.pid, decision.pgroup);
  } catch (e) {
    // The instance is not down — keep the runfile, otherwise it vanishes from `wt ps`/`wt stop --all`,
    // and the orphaned container later breaks `wt start` (docker run → 125, name already in use).
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
  await unlink(file).catch(() => {});
  return { ...base, error: null };
}

/** `wt stop <p> <slug>`: stop the instance + remove the runfile. null if there is no runfile. Parity with cmd_stop. */
export async function stopInstance(
  orch: string,
  project: string,
  slug: string,
  probes: AliveProbes = defaultProbes,
  actions: StopActions = defaultStopActions,
): Promise<StopOutcome | null> {
  return applyStop(runFilePath(orch, project, slug), probes, actions);
}

/** `wt stop --all`: stop every instance from `var/run/*.run`. Parity with cmd_stop --all. */
export async function stopAll(
  orch: string,
  probes: AliveProbes = defaultProbes,
  actions: StopActions = defaultStopActions,
): Promise<StopOutcome[]> {
  const dir = runDir(orch);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".run"));
  } catch {
    return [];
  }
  const out: StopOutcome[] = [];
  for (const f of files.sort()) {
    const r = await applyStop(resolve(dir, f), probes, actions);
    if (r) out.push(r);
  }
  return out;
}

export interface ReapActions {
  /** docker ps -aq --filter name=wtdev- → ids/names of the dev containers. */
  listDevContainers: () => Promise<string[]>;
  /** docker rm -f <ids…>. */
  removeContainers: (ids: string[]) => Promise<void>;
}

const defaultReapActions: ReapActions = {
  listDevContainers: () => dockerPs(["-aq", "--filter", "name=wtdev-"]),
  removeContainers: (ids) => dockerRemove(ids),
};

/**
 * `wt reap`: remove ALL wtdev-* dev containers + clean up their runfiles
 * (a guaranteed orphan sweep). Parity with cmd_reap.
 */
export async function reapContainers(
  orch: string,
  actions: ReapActions = defaultReapActions,
): Promise<{ removed: number }> {
  const ids = await actions.listDevContainers();
  if (ids.length) await actions.removeContainers(ids);
  const dir = runDir(orch);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".run"));
  } catch {
    return { removed: ids.length };
  }
  for (const f of files) {
    const rs = await parseRunState(resolve(dir, f));
    if (rs?.container) await unlink(resolve(dir, f)).catch(() => {});
  }
  return { removed: ids.length };
}

export type LogSource = { kind: "docker"; container: string } | { kind: "file"; path: string };

/**
 * Where `wt logs <p> <slug>` reads logs from: the container (docker logs) if the instance is
 * dockerized, otherwise the host logfile if it exists. null if neither. Parity with cmd_logs.
 */
export async function resolveLogSource(orch: string, project: string, slug: string): Promise<LogSource | null> {
  const rs = await parseRunState(runFilePath(orch, project, slug));
  if (rs?.container) return { kind: "docker", container: rs.container };
  const lf = logFilePath(orch, project, slug);
  if (existsSync(lf)) return { kind: "file", path: lf };
  return null;
}

/**
 * One-off idempotent migration of the base checkout's artifacts: rename
 * `var/{run,settings,env}/<project>-main.<ext>` → `-base.<ext>` after the
 * MAIN_SLUG→BASE_SLUG rename (M2.5). Matches on the `-main.` slug segment (project names
 * contain dashes, but the slug is the last segment before the extension). Does not clobber:
 * if `-base.<ext>` already exists, `-main.<ext>` is left alone. It also skips the artifacts of
 * a real feature worktree with the slug "main" (`wt new <p> main` — the slug "main" is not
 * reserved, only "base" is): if `worktrees/<project>/main` exists, it is a real
 * worktree, not the base checkout sentinel (which has NO worktree directory) —
 * such a `-main.*` is left untouched. Returns the names of the moved files.
 */
export async function migrateBaseSlugArtifacts(orch: string): Promise<string[]> {
  const dirs = [runDir(orch), resolve(orch, "var", "settings"), resolve(orch, "var", "env")];
  const moved: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of await readdir(dir)) {
      const m = f.match(/^(.+)-main(\..+)$/);
      if (!m) continue;
      if (existsSync(worktreeDir(orch, m[1], "main"))) continue; // a real feature/main worktree — leave it alone
      const target = `${m[1]}-base${m[2]}`;
      if (existsSync(resolve(dir, target))) continue; // do not clobber
      await rename(resolve(dir, f), resolve(dir, target));
      moved.push(f);
    }
  }
  return moved;
}

/** All host logfiles (one `.log` per `.run`). Parity with cmd_logs --all. */
export async function listLogFiles(orch: string): Promise<string[]> {
  const dir = runDir(orch);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".run"));
  } catch {
    return [];
  }
  return files.sort().map((f) => resolve(dir, f.replace(/\.run$/, ".log")));
}
