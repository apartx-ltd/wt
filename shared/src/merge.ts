import type { Worktree, RunInstance, MergedInstance, BaseSpec } from "./types";

const BASE_SLUG = "base";

export function branchToSlug(branch: string, prefix = "feature/", baseSlug = "base"): string {
  if (branch.startsWith(prefix)) return branch.slice(prefix.length);
  return baseSlug;
}

export function mergeInstances(
  worktrees: Worktree[],
  running: RunInstance[],
  bases: BaseSpec[] = [],
): MergedInstance[] {
  const byKey = new Map<string, MergedInstance>();
  const key = (project: string, slug: string) => `${project} ${slug}`;

  for (const b of bases) {
    byKey.set(key(b.project, BASE_SLUG), {
      project: b.project, slug: BASE_SLUG, branch: b.branch, port: b.port,
      status: "down", pid: null, container: null, started: null,
    });
  }

  for (const w of worktrees) {
    // Use the worktree's directory name as the slug — that's what start/stop/port/rm
    // resolve by. Deriving it from the branch (branchToSlug) breaks when a worktree's
    // dir name differs from its branch (e.g. dir eu-accounting-1a on feature/eu-accounting),
    // and would also double a running such instance against its dir-slug runfile row.
    byKey.set(key(w.project, w.slug), {
      project: w.project, slug: w.slug, branch: w.branch, port: w.port,
      status: "down", pid: null, container: null, started: null,
    });
  }

  for (const r of running) {
    const k = key(r.project, r.slug);
    const existing = byKey.get(k);
    const merged: MergedInstance = {
      project: r.project, slug: r.slug, branch: r.branch,
      port: r.port ?? existing?.port ?? null,
      status: r.alive ? "up" : "down",
      pid: r.pid, container: r.container, started: r.started,
    };
    byKey.set(k, merged);
  }

  const rank = (m: MergedInstance) => (m.slug === BASE_SLUG ? 1 : 0);
  return [...byKey.values()].sort(
    (a, b) => rank(a) - rank(b) || a.project.localeCompare(b.project) || a.slug.localeCompare(b.slug),
  );
}
