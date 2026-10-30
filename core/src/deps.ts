import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

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

/** sha256 over the contents of the directory's package files (the name is part of the hash — moving content between files won't match). */
export async function depsHash(dir: string): Promise<string> {
  const h = createHash("sha256");
  for (const name of DEPS_FILES) {
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

/** Volume probe script: the first line is any entry (empty = the volume is empty), the rest is the fingerprint. */
const PROBE_SCRIPT = `ls -A /nm 2>/dev/null | head -1; cat /nm/${DEPS_STAMP} 2>/dev/null`;

/** Parse the output of PROBE_SCRIPT. */
export function parseVolumeProbe(out: string): DepsState {
  const [first = "", ...rest] = out.split("\n");
  const stamp = rest.join("\n").trim();
  return { empty: first.trim() === "", stamp: stamp || null };
}

function staleNotice(where: string): void {
  process.stderr.write(`wt: dependencies in ${where} do not match package.json/lock — reinstalling\n`);
}

async function shInherit(cmd: string[], cwd?: string): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`command exited with code ${code}: ${cmd.join(" ")}`);
}

/**
 * Install dependencies into the container's node_modules volume (`docker run --rm` with the plugin's volumes)
 * and write the fingerprint into the same volume. Shared by `wt new` and `wt start`.
 */
export async function installDockerDeps(
  dir: string,
  container: string,
  image: string,
  mounts: string[],
  installArgv: string[],
): Promise<void> {
  const before = await depsHash(dir);
  // Fallback to the default meteor layout: a plugin without docker() described no volumes, but
  // only dockerized projects get here — mount at least the repo.
  const volumes = mounts.length ? mounts : [`${dir}:/opt/app`, `${container}-node_modules:/opt/app/node_modules`];
  await shInherit([
    "docker", "run", "--rm",
    ...volumes.flatMap((m) => ["-v", m]),
    "-w", "/opt/app", image, ...installArgv,
  ]);
  const stamp = formatDepsStamp(before, await depsHash(dir));
  await shInherit([
    "docker", "run", "--rm", "-v", `${container}-node_modules:/nm`, image,
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
): Promise<void> {
  const probe = Bun.spawn(
    ["docker", "run", "--rm", "-v", `${container}-node_modules:/nm`, image, "sh", "-c", PROBE_SCRIPT],
    { stdout: "pipe", stderr: "ignore" },
  );
  const state = parseVolumeProbe(await new Response(probe.stdout).text());
  await probe.exited;
  const verdict = depsVerdict(state, await depsHash(dir));
  if (verdict === "ok") return;
  if (verdict === "stale") staleNotice(`${container}-node_modules`);
  await installDockerDeps(dir, container, image, mounts, installArgv);
}

/** Host install in the worktree directory + fingerprint in its node_modules. */
export async function installHostDeps(dir: string, installArgv: string[]): Promise<void> {
  const before = await depsHash(dir);
  await shInherit(installArgv, dir);
  await mkdir(resolve(dir, "node_modules"), { recursive: true });
  await writeFile(resolve(dir, "node_modules", DEPS_STAMP), formatDepsStamp(before, await depsHash(dir)));
}

/** Host counterpart of ensureDeps: node_modules is missing (removed by `wt slim`) or stale — run the plugin's install. */
export async function ensureHostDeps(dir: string, installArgv: string[]): Promise<void> {
  const nm = resolve(dir, "node_modules");
  const stampPath = resolve(nm, DEPS_STAMP);
  const state: DepsState = {
    empty: !existsSync(nm),
    stamp: existsSync(stampPath) ? await readFile(stampPath, "utf8") : null,
  };
  const verdict = depsVerdict(state, await depsHash(dir));
  if (verdict === "ok") return;
  if (verdict === "stale") staleNotice(nm);
  await installHostDeps(dir, installArgv);
}
