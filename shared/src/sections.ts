import type { MergedInstance } from "./types";

export interface InstanceSection {
  key: "worktrees" | "base";
  label: string;
  rows: MergedInstance[];
}

/**
 * Group a merged (already sorted worktrees-first-then-base) instance list into
 * ordered, non-empty sections for rendering subtitles. Order: worktrees, base.
 */
export function sections(instances: MergedInstance[]): InstanceSection[] {
  const worktrees = instances.filter((i) => i.slug !== "base");
  const base = instances.filter((i) => i.slug === "base");
  const out: InstanceSection[] = [];
  if (worktrees.length) out.push({ key: "worktrees", label: "worktrees", rows: worktrees });
  if (base.length) out.push({ key: "base", label: "base checkouts", rows: base });
  return out;
}
