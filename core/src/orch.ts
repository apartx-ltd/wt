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
  if (env.WT_ORCH) return canonical(env.WT_ORCH);
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(resolve(dir, "wt.config.ts"))) return canonical(dir);
    if (dirname(dir) === dir) throw new WorkspaceNotFoundError(cwd);
  }
}

/** Root of the `@apartx/wt` package (core/src → two levels up). */
export function packageRoot(): string {
  return canonical(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."));
}

/**
 * Регистр как на диске: на регистронезависимой ФС `cd ~/projects/apartx` даёт ORCH со
 * строчной буквой, а git отдаёт пути worktree в настоящем регистре — префиксные сравнения
 * (listWorktrees) молча не совпадали, и `wt list`/`slim` видели 0 worktree.
 */
function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}
