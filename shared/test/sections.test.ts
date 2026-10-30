import { test, expect } from "bun:test";
import { sections } from "../src/sections";
import type { MergedInstance } from "../src/types";

const row = (project: string, slug: string): MergedInstance => ({
  project, slug, branch: slug === "base" ? "develop" : `feature/${slug}`,
  port: 3000, status: "down", pid: null, container: null, started: null,
});

test("splits into worktrees then base, omitting empty sections", () => {
  const secs = sections([row("a", "x"), row("a", "base"), row("b", "base")]);
  expect(secs.map((s) => s.key)).toEqual(["worktrees", "base"]);
  expect(secs[0]).toMatchObject({ label: "worktrees" });
  expect(secs[0].rows.map((r) => r.slug)).toEqual(["x"]);
  expect(secs[1]).toMatchObject({ label: "base checkouts" });
  expect(secs[1].rows.map((r) => `${r.project}/${r.slug}`)).toEqual(["a/base", "b/base"]);
});

test("omits the worktrees section when there are only base rows", () => {
  const secs = sections([row("a", "base")]);
  expect(secs.map((s) => s.key)).toEqual(["base"]);
});

test("preserves the flat order of the input within sections", () => {
  const input = [row("a", "x"), row("b", "y"), row("a", "base")];
  const flat = sections(input).flatMap((s) => s.rows);
  expect(flat).toEqual(input);
});
