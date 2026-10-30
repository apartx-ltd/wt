import { resolve, basename } from "node:path";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolveProjectsDir } from "./config";

/** Имена проектов: single-repo (projectsDir ".") → [basename(orch)]; иначе каталоги `<orch>/projects/*` с `.git`. */
export async function listProjects(orch: string): Promise<string[]> {
  const pd = await resolveProjectsDir(orch);
  if (pd === ".") return existsSync(resolve(orch, ".git")) ? [basename(orch)] : [];
  const dir = resolve(orch, pd);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  // .git может быть каталогом (обычный repo) или файлом (worktree/submodule) —
  // existsSync ловит оба. Паритет с `[ -d .git ] || [ -f .git ]`.
  return entries.filter((name) => existsSync(resolve(dir, name, ".git"))).sort();
}
