import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, basename } from "node:path";
import { listProjects } from "../src/projects";

const singleRepoConfig = () =>
  `import { defineWorkspace } from "${resolve(import.meta.dir, "../src/config")}";\n` +
  `export default defineWorkspace({ branches: { base: "main", prefix: "feat/" }, project: { plugin: "@wt/plugin-node" } });\n`;

// Built at runtime: a `.git` marker file can't be committed (git rejects paths
// with a `.git` component), so we synthesize the fixture orchestrator in a temp dir.
let orch: string;

beforeAll(() => {
  orch = mkdtempSync(resolve(tmpdir(), "wt-projects-"));
  const projects = resolve(orch, "projects");
  for (const name of ["apartx-server", "apartx-cabinet", "not-a-repo"]) {
    mkdirSync(resolve(projects, name), { recursive: true });
  }
  // .git as a file (worktree/submodule style) for one, dir for the other.
  writeFileSync(resolve(projects, "apartx-server", ".git"), "gitdir: /somewhere\n");
  mkdirSync(resolve(projects, "apartx-cabinet", ".git"));
  // not-a-repo has no .git → excluded
});

afterAll(() => {
  rmSync(orch, { recursive: true, force: true });
});

test("listProjects returns .git-bearing dirs, sorted, excludes non-repos", async () => {
  expect(await listProjects(orch)).toEqual(["apartx-cabinet", "apartx-server"]);
});

test("listProjects returns [] when projects/ absent", async () => {
  expect(await listProjects("/tmp/no-such-orch-xyz")).toEqual([]);
});

test("listProjects single-repo: returns [basename(orch)] when wt.config.ts uses `project:`", async () => {
  const single = mkdtempSync(resolve(tmpdir(), "wt-single-"));
  try {
    mkdirSync(resolve(single, ".git"), { recursive: true });
    writeFileSync(resolve(single, "wt.config.ts"), singleRepoConfig());
    expect(await listProjects(single)).toEqual([basename(single)]);
  } finally {
    rmSync(single, { recursive: true, force: true });
  }
});

test("listProjects single-repo: returns [] when the orch root has no .git", async () => {
  const single = mkdtempSync(resolve(tmpdir(), "wt-single-nogit-"));
  try {
    writeFileSync(resolve(single, "wt.config.ts"), singleRepoConfig());
    expect(await listProjects(single)).toEqual([]);
  } finally {
    rmSync(single, { recursive: true, force: true });
  }
});
