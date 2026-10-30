import { test, expect } from "bun:test";
import { parseWorktreePorcelain } from "../src/worktrees";

const SAMPLE = `worktree /repo/projects/apartx-server
HEAD abc
branch refs/heads/main

worktree /repo/worktrees/apartx-server/feat-a
HEAD def
branch refs/heads/feature/feat-a

worktree /repo/worktrees/apartx-server/detached
HEAD 999
detached
`;

test("parseWorktreePorcelain extracts path + branch pairs", () => {
  expect(parseWorktreePorcelain(SAMPLE)).toEqual([
    { path: "/repo/projects/apartx-server", branch: "main" },
    { path: "/repo/worktrees/apartx-server/feat-a", branch: "feature/feat-a" },
    { path: "/repo/worktrees/apartx-server/detached", branch: "" },
  ]);
});
