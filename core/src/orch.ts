import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

/**
 * Корень оркестратора (репо apartx). shim передаёт WT_ORCH явно; при прямом
 * запуске cli выводим из расположения этого модуля: core/src → подняться на
 * tools/wt/core/src = 4 уровня до корня репо.
 */
export function resolveOrch(env: Record<string, string | undefined> = process.env): string {
  const here = dirname(fileURLToPath(import.meta.url)); // .../tools/wt/core/src
  return canonical(env.WT_ORCH || resolve(here, "..", "..", "..", ".."));
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
