import { resolve, basename } from "node:path";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolveProjectsDir } from "./config";

/** Project names: single-repo (projectsDir ".") → [basename(orch)]; otherwise the `<orch>/projects/*` directories that have a `.git`. */
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
  // .git can be a directory (a regular repo) or a file (worktree/submodule) —
  // existsSync catches both. Parity with `[ -d .git ] || [ -f .git ]`.
  return entries.filter((name) => existsSync(resolve(dir, name, ".git"))).sort();
}
