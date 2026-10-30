import { test, expect } from "bun:test";
import { projectDir, worktreeDir } from "../src/paths";
import { resolve } from "node:path";

test("projectDir multi-repo (default): <orch>/projects/<p>", () => {
  expect(projectDir("/o", "apartx-server")).toBe(resolve("/o", "projects", "apartx-server"));
  expect(projectDir("/o", "apartx-server", "projects")).toBe(resolve("/o", "projects", "apartx-server"));
});

test("projectDir single-repo (projectsDir '.'): the orch root itself", () => {
  expect(projectDir("/o/myapp", "myapp", ".")).toBe(resolve("/o/myapp"));
});

test("worktreeDir is <orch>/worktrees/<p>/<slug> for both topologies", () => {
  expect(worktreeDir("/o", "p", "s")).toBe(resolve("/o", "worktrees", "p", "s"));
});
