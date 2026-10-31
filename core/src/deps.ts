import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { DepsSpec } from "./plugin";

/**
 * Dependency fingerprint at the root of node_modules (in the container volume or in the host project dir).
 * Written after every install; `wt start` compares it with the current package files and
 * reinstalls if they diverged. Without it a non-empty volume was considered good forever:
 * merging develop / checking out another commit in a worktree does not touch dependencies, and the
 * instance silently ran on stale versions (a stale svelte 5.56 in one project brought back an already-fixed triple-render bug).
 */
export const DEPS_STAMP = ".wt-deps-hash";

/** Files the package manager uses to decide what to install. Missing ones are skipped. */
const DEPS_FILES = ["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"];

/** The node layout — what every plugin without its own `deps` gets. */
export const NODE_DEPS: DepsSpec = { dir: "node_modules", files: DEPS_FILES };

/**
 * Name of the container volume holding the deps dir: `<container>-<dir>` with the path
 * flattened (`.meteor/local` → `meteor_local`), which is the naming the plugins' `docker()`
 * mounts already use — so the core's probe and the plugin's mount meet on the same volume.
 */
export function depsVolume(container: string, spec: DepsSpec = NODE_DEPS): string {
  return `${container}-${spec.dir.replace(/^\./, "").replace(/\//g, "_")}`;
}

/** sha256 over the contents of the spec's files (the name is part of the hash — moving content between files won't match). */
export async function depsHash(dir: string, spec: DepsSpec = NODE_DEPS): Promise<string> {
  const h = createHash("sha256");
  for (const name of spec.files) {
    const path = resolve(dir, name);
    if (!existsSync(path)) continue;
    h.update(`${name}\0`);
    h.update(await readFile(path));
    h.update("\0");
  }
  return h.digest("hex");
}

/**
 * Fingerprint contents: the hashes BEFORE and AFTER the install. npm rewrites
 * package-lock.json during install (npm version drift), and worktrees are then often reverted with
 * `git checkout -- package-lock.json` — both states describe the same dependencies,
 * and neither should trigger a reinstall on every start.
 */
export function formatDepsStamp(before: string, after: string): string {
  return before === after ? `${after}\n` : `${before}\n${after}\n`;
}

export interface DepsState {
  /** node_modules is missing or empty (fresh volume, `wt slim`). */
  empty: boolean;
  /** contents of DEPS_STAMP; null — no fingerprint (the volume was installed before the check existed). */
  stamp: string | null;
}

export type DepsVerdict = "ok" | "empty" | "stale";

/** Empty → install; no fingerprint, or the current hash is not in it → reinstall. */
export function depsVerdict(state: DepsState, current: string): DepsVerdict {
  if (state.empty) return "empty";
  const known = (state.stamp ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  return known.includes(current) ? "ok" : "stale";
}

/** Volume probe script (the deps volume is mounted at /nm): the first line is any entry (empty = the volume is empty), the rest is the fingerprint. */
const PROBE_SCRIPT = `ls -A /nm 2>/dev/null | head -1; cat /nm/${DEPS_STAMP} 2>/dev/null`;

/** Parse the output of PROBE_SCRIPT. */
export function parseVolumeProbe(out: string): DepsState {
  const [first = "", ...rest] = out.split("\n");
  const stamp = rest.join("\n").trim();
  return { empty: first.trim() === "", stamp: stamp || null };
}

function staleNotice(where: string, spec: DepsSpec): void {
  process.stderr.write(`wt: dependencies in ${where} do not match ${spec.files.join("/")} — reinstalling\n`);
}

async function shInherit(cmd: string[], cwd?: string): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`command exited with code ${code}: ${cmd.join(" ")}`);
}

/**
 * Install dependencies into the container's deps volume (`docker run --rm` with the plugin's volumes)
 * and write the fingerprint into the same volume. Shared by `wt new` and `wt start`.
 */
export async function installDockerDeps(
  dir: string,
  container: string,
  image: string,
  mounts: string[],
  installArgv: string[],
  spec: DepsSpec = NODE_DEPS,
): Promise<void> {
  const before = await depsHash(dir, spec);
  // Fallback to the default layout: a plugin without docker() described no volumes, but
  // only dockerized projects get here — mount at least the repo and the deps volume.
  const volumes = mounts.length ? mounts : [`${dir}:/opt/app`, `${depsVolume(container, spec)}:/opt/app/${spec.dir}`];
  await shInherit([
    "docker", "run", "--rm",
    ...volumes.flatMap((m) => ["-v", m]),
    "-w", "/opt/app", image, ...installArgv,
  ]);
  const stamp = formatDepsStamp(before, await depsHash(dir, spec));
  await shInherit([
    "docker", "run", "--rm", "-v", `${depsVolume(container, spec)}:/nm`, image,
    "sh", "-c", `printf '%s' "$1" > /nm/${DEPS_STAMP}`, "sh", stamp,
  ]);
}

/**
 * Before starting a dockerized instance: empty volume — install; fingerprint does not match
 * the current package files — reinstall. Volumes and the command come from the plugin
 * (`docker().mounts` / `install().argv`). Parity with ensure_deps + a staleness check.
 */
export async function ensureDeps(
  dir: string,
  container: string,
  image: string,
  mounts: string[],
  installArgv: string[],
  spec: DepsSpec = NODE_DEPS,
): Promise<void> {
  const volume = depsVolume(container, spec);
  const probe = Bun.spawn(
    ["docker", "run", "--rm", "-v", `${volume}:/nm`, image, "sh", "-c", PROBE_SCRIPT],
    { stdout: "pipe", stderr: "ignore" },
  );
  const state = parseVolumeProbe(await new Response(probe.stdout).text());
  await probe.exited;
  const verdict = depsVerdict(state, await depsHash(dir, spec));
  if (verdict === "ok") return;
  if (verdict === "stale") staleNotice(volume, spec);
  await installDockerDeps(dir, container, image, mounts, installArgv, spec);
}

/** Host install in the worktree directory + fingerprint in its deps dir. */
export async function installHostDeps(dir: string, installArgv: string[], spec: DepsSpec = NODE_DEPS): Promise<void> {
  const before = await depsHash(dir, spec);
  await shInherit(installArgv, dir);
  await mkdir(resolve(dir, spec.dir), { recursive: true });
  await writeFile(resolve(dir, spec.dir, DEPS_STAMP), formatDepsStamp(before, await depsHash(dir, spec)));
}

/** Host counterpart of ensureDeps: the deps dir is missing (removed by `wt slim`) or stale — run the plugin's install. */
export async function ensureHostDeps(dir: string, installArgv: string[], spec: DepsSpec = NODE_DEPS): Promise<void> {
  const depsDir = resolve(dir, spec.dir);
  const stampPath = resolve(depsDir, DEPS_STAMP);
  const state: DepsState = {
    empty: !existsSync(depsDir),
    stamp: existsSync(stampPath) ? await readFile(stampPath, "utf8") : null,
  };
  const verdict = depsVerdict(state, await depsHash(dir, spec));
  if (verdict === "ok") return;
  if (verdict === "stale") staleNotice(depsDir, spec);
  await installHostDeps(dir, installArgv, spec);
}
