import { resolve, basename } from "node:path";
import type { Worktree } from "@wt/shared";
import { listProjects } from "./projects";
import { readWorktreePort } from "./ports";
import { projectDir } from "./paths";
import { resolveProjectsDir } from "./config";

export interface PorcelainEntry {
  path: string;
  branch: string; // без refs/heads/, "" для detached
}

/** Разбор `git worktree list --porcelain` (паритет с awk в cmd_list). */
export function parseWorktreePorcelain(text: string): PorcelainEntry[] {
  const out: PorcelainEntry[] = [];
  let path: string | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("worktree ")) {
      path = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      if (path !== null) {
        out.push({ path, branch: line.slice("branch ".length).replace(/^refs\/heads\//, "") });
        path = null;
      }
    } else if (line === "detached") {
      if (path !== null) {
        out.push({ path, branch: "" });
        path = null;
      }
    }
  }
  return out;
}

async function gitWorktrees(projectDir: string): Promise<PorcelainEntry[]> {
  const proc = Bun.spawn(["git", "-C", projectDir, "worktree", "list", "--porcelain"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [text, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  // Сбой git не должен выглядеть как «worktree нет»: на пустом списке `wt slim` счёл бы сиротами все тома.
  if ((await proc.exited) !== 0) throw new Error(`git worktree list (${projectDir}): ${err.trim() || "failed"}`);
  return parseWorktreePorcelain(text);
}

/**
 * Worktree’ы под `<orch>/worktrees/` по всем (или одному) проектам, с PORT из
 * `.env.worktree`. Паритет с `wt list --json`.
 */
export async function listWorktrees(orch: string, project?: string): Promise<Worktree[]> {
  const projects = project ? [project] : await listProjects(orch);
  const projectsDir = await resolveProjectsDir(orch);
  const wtRoot = resolve(orch, "worktrees") + "/";
  const out: Worktree[] = [];
  for (const proj of projects) {
    const entries = await gitWorktrees(projectDir(orch, proj, projectsDir));
    for (const e of entries) {
      if (!e.path.startsWith(wtRoot)) continue;
      out.push({ project: proj, slug: basename(e.path), branch: e.branch, port: await readWorktreePort(e.path), path: e.path });
    }
  }
  return out;
}
