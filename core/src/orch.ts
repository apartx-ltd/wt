import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, realpathSync } from "node:fs";

/** No `wt.config.ts` in `cwd` or any of its parents, and `WT_ORCH` is not set. */
export class WorkspaceNotFoundError extends Error {
  constructor(cwd: string) {
    super(`no wt.config.ts found in ${cwd} or any parent directory (create one at the workspace root, or set WT_ORCH)`);
    this.name = "WorkspaceNotFoundError";
  }
}

/**
 * Workspace root: `WT_ORCH` when set; otherwise the first directory from `cwd` upwards that
 * holds a `wt.config.ts` (the way git finds `.git`). Throws `WorkspaceNotFoundError` when
 * the search reaches the filesystem root empty-handed.
 */
export function resolveOrch(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): string {
  if (env.WT_ORCH) return canonicalPath(env.WT_ORCH);
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(resolve(dir, "wt.config.ts"))) return canonicalPath(dir);
    if (dirname(dir) === dir) throw new WorkspaceNotFoundError(cwd);
  }
}

/** Root of the `@apartx/wt` package (core/src → two levels up). */
export function packageRoot(): string {
  return canonicalPath(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."));
}

/** The built web dashboard (`bun run build:web`), served by wt-server itself. */
export function webBuildDir(root = packageRoot()): string {
  return resolve(root, "web/build");
}

/**
 * Case as on disk: on a case-insensitive filesystem `cd ~/projects/apartx` yields an ORCH with a
 * lowercase letter, while git reports worktree paths in their real case — the prefix comparisons
 * (listWorktrees) silently failed to match, and `wt list`/`slim` saw 0 worktrees.
 */
export function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}
