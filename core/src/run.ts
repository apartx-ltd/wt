import { resolve } from "node:path";
import { readdir, unlink, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { RunInstance } from "@wt/shared";
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
  /** host-инстанс запущен в своей process-group (kill -- -PGID при stop). */
  pgroup: boolean;
}

const toNum = (v: string | undefined): number | null => {
  if (v === undefined || v === "") return null;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};

/** Разбор `.run` (k=v строки). null если файла нет. Паритет с read_run(). */
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

/** Содержимое `.run`-файла. Паритет с блоками `{ echo … } > rf` в cmd_start (порядок ключей важен). */
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
 * Что делать при `wt stop`: контейнер (docker rm -f, всегда), либо живой host-pid
 * (kill_tree), либо просто подчистить runfile. Паритет с cmd_stop.
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

/** Жив ли инстанс: контейнер→docker, иначе pid. Паритет с inst_alive(). */
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

/** Живые инстансы из `<orch>/var/run/*.run`. Паритет с `wt ps --json`. */
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
  /** docker rm -f <container> (no-op если не запущен); кидает, если контейнер остался. */
  dockerRm: (container: string) => Promise<void>;
  /** kill_tree: pgroup → TERM группе, 10с, затем KILL; иначе TERM процессу. */
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
  /** Причина неудачи; null — инстанс снят. При ошибке runfile НЕ удаляется. */
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
    // Инстанс не снят — runfile оставляем, иначе он исчезнет из `wt ps`/`wt stop --all`,
    // а осиротевший контейнер потом сломает `wt start` (docker run → 125, имя занято).
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
  await unlink(file).catch(() => {});
  return { ...base, error: null };
}

/** `wt stop <p> <slug>`: остановить инстанс + убрать runfile. null если runfile нет. Паритет cmd_stop. */
export async function stopInstance(
  orch: string,
  project: string,
  slug: string,
  probes: AliveProbes = defaultProbes,
  actions: StopActions = defaultStopActions,
): Promise<StopOutcome | null> {
  return applyStop(runFilePath(orch, project, slug), probes, actions);
}

/** `wt stop --all`: остановить все инстансы из `var/run/*.run`. Паритет cmd_stop --all. */
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
  /** docker ps -aq --filter name=wtdev- → список id/имён dev-контейнеров. */
  listDevContainers: () => Promise<string[]>;
  /** docker rm -f <ids…>. */
  removeContainers: (ids: string[]) => Promise<void>;
}

const defaultReapActions: ReapActions = {
  listDevContainers: () => dockerPs(["-aq", "--filter", "name=wtdev-"]),
  removeContainers: (ids) => dockerRemove(ids),
};

/**
 * `wt reap`: снести ВСЕ dev-контейнеры wtdev-* + подчистить их runfiles
 * (гарантированная зачистка сирот). Паритет cmd_reap.
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
 * Откуда читать логи `wt logs <p> <slug>`: контейнер (docker logs) если инстанс
 * dockerized, иначе host-logfile если он есть. null если ни того, ни другого. Паритет cmd_logs.
 */
export async function resolveLogSource(orch: string, project: string, slug: string): Promise<LogSource | null> {
  const rs = await parseRunState(runFilePath(orch, project, slug));
  if (rs?.container) return { kind: "docker", container: rs.container };
  const lf = logFilePath(orch, project, slug);
  if (existsSync(lf)) return { kind: "file", path: lf };
  return null;
}

/**
 * Одноразовая идемпотентная миграция артефактов базового checkout: переименование
 * `var/{run,settings,env}/<project>-main.<ext>` → `-base.<ext>` после ренейма
 * MAIN_SLUG→BASE_SLUG (M2.5). Совпадение по сегменту слуга `-main.` (имена проектов
 * содержат дефисы, но слуг — последний сегмент перед расширением). Не клоббрит:
 * если `-base.<ext>` уже есть, `-main.<ext>` оставляется. Также пропускает артефакты
 * настоящего feature-worktree со слугом "main" (`wt new <p> main` — слуг "main" не
 * зарезервирован, только "base"): если `worktrees/<project>/main` существует, это реальный
 * worktree, а не sentinel базового checkout (у которого worktree-директории НЕТ) —
 * такой `-main.*` не трогаем. Возвращает имена перемещённых файлов.
 */
export async function migrateBaseSlugArtifacts(orch: string): Promise<string[]> {
  const dirs = [runDir(orch), resolve(orch, "var", "settings"), resolve(orch, "var", "env")];
  const moved: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of await readdir(dir)) {
      const m = f.match(/^(.+)-main(\..+)$/);
      if (!m) continue;
      if (existsSync(worktreeDir(orch, m[1], "main"))) continue; // реальный feature/main worktree — не трогаем
      const target = `${m[1]}-base${m[2]}`;
      if (existsSync(resolve(dir, target))) continue; // не клоббрить
      await rename(resolve(dir, f), resolve(dir, target));
      moved.push(f);
    }
  }
  return moved;
}

/** Все host-logfile'ы (по одному `.log` на каждый `.run`). Паритет cmd_logs --all. */
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
