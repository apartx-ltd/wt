import { test, it, expect } from "bun:test";
import { mergeInstances, branchToSlug } from "../src/merge";
import type { Worktree, RunInstance, BaseSpec } from "../src/types";

it("maps prefixed branches to their slug", () => {
  expect(branchToSlug("feature/eu-x")).toBe("eu-x");
});
it("maps non-prefixed branches to the base slug 'base'", () => {
  expect(branchToSlug("develop")).toBe("base");
  expect(branchToSlug("main")).toBe("base");
});
it("honors custom prefix + baseSlug", () => {
  expect(branchToSlug("feat/x", "feat/", "trunk")).toBe("x");
  expect(branchToSlug("trunk", "feat/", "trunk")).toBe("trunk");
});

test("merges a running worktree into up status", () => {
  const worktrees: Worktree[] = [
    { project: "apartx-cabinet", slug: "x", branch: "feature/x", port: 4231, path: "/w/x" },
  ];
  const running: RunInstance[] = [
    { project: "apartx-cabinet", slug: "x", branch: "feature/x", port: 4231,
      pid: 12345, container: "wtdev-apartx-cabinet-x", started: 100, alive: true },
  ];
  const merged = mergeInstances(worktrees, running);
  expect(merged).toHaveLength(1);
  expect(merged[0]).toMatchObject({ project: "apartx-cabinet", slug: "x", status: "up", port: 4231 });
});

test("worktree with no running instance is down", () => {
  const merged = mergeInstances(
    [{ project: "apartx-spaces", slug: "y", branch: "feature/y", port: 3512, path: "/w/y" }],
    [],
  );
  expect(merged[0].status).toBe("down");
  expect(merged[0].slug).toBe("y");
});

test("worktree slug is the directory name, not the branch-derived slug", () => {
  // dir eu-accounting-1a on branch feature/eu-accounting: the slug must be the dir
  // (what start/stop resolve by), and a running instance keyed by that dir-slug must
  // merge into the same row — no branch-slug duplicate.
  const merged = mergeInstances(
    [{ project: "apartx-server", slug: "eu-accounting-1a", branch: "feature/eu-accounting",
       port: 4030, path: "/w/apartx-server/eu-accounting-1a" }],
    [{ project: "apartx-server", slug: "eu-accounting-1a", branch: "feature/eu-accounting",
       port: 4030, pid: 7, container: "wtdev-apartx-server-eu-accounting-1a", started: 5, alive: true }],
  );
  expect(merged).toHaveLength(1);
  expect(merged[0]).toMatchObject({ slug: "eu-accounting-1a", status: "up" });
});

test("running instance without a worktree row still appears (e.g. main checkout)", () => {
  const merged = mergeInstances(
    [],
    [{ project: "apartx-server", slug: "main", branch: "main", port: 4000,
       pid: 1, container: "wtdev-apartx-server-main", started: 0, alive: true }],
  );
  expect(merged).toHaveLength(1);
  expect(merged[0].status).toBe("up");
});

test("seeds a synthetic down base row per project from bases", () => {
  const merged = mergeInstances([], [], [
    { project: "apartx-cabinet", branch: "develop", port: 3500 },
  ]);
  expect(merged).toHaveLength(1);
  expect(merged[0]).toMatchObject({
    project: "apartx-cabinet", slug: "base", branch: "develop", port: 3500, status: "down",
  });
});

test("a running base instance overrides its synthetic base row", () => {
  const bases: BaseSpec[] = [{ project: "apartx-cabinet", branch: "develop", port: 3500 }];
  const merged = mergeInstances([], [
    { project: "apartx-cabinet", slug: "base", branch: "develop", port: 3500,
      pid: 999, container: null, started: 42, alive: true },
  ], bases);
  expect(merged).toHaveLength(1);
  expect(merged[0]).toMatchObject({ slug: "base", status: "up", pid: 999, started: 42 });
});

test("sorts worktrees before base rows, each by project", () => {
  const merged = mergeInstances(
    [{ project: "apartx-cabinet", slug: "x", branch: "feature/x", port: 4231, path: "/w/x" }],
    [],
    [
      { project: "apartx-server", branch: "develop", port: 4000 },
      { project: "apartx-cabinet", branch: "develop", port: 3500 },
    ],
  );
  expect(merged.map((m) => `${m.project}/${m.slug}`)).toEqual([
    "apartx-cabinet/x",
    "apartx-cabinet/base",
    "apartx-server/base",
  ]);
});
