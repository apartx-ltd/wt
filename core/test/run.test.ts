import { test, expect, it } from "bun:test";
import { resolve, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parseRunState, isInstanceAlive, formatRunState, stopDecision, migrateBaseSlugArtifacts, type RunState } from "../src/run";

const fx = resolve(import.meta.dir, "fixtures/run/apartx-server-feat.run");

test("parseRunState parses k=v run file", async () => {
  const rs = await parseRunState(fx);
  expect(rs).toEqual({
    project: "apartx-server",
    slug: "feat",
    branch: "feature/feat",
    port: 4010,
    pid: null,
    container: "wtdev-apartx-server-feat",
    started: 1700000000,
    pgroup: false,
  });
});

test("parseRunState returns null for missing file", async () => {
  expect(await parseRunState("/tmp/nope.run")).toBeNull();
});

test("isInstanceAlive: container path uses docker probe", async () => {
  const rs: RunState = { project: "p", slug: "s", branch: "b", port: 1, pid: null, container: "c", started: 0, pgroup: false };
  expect(await isInstanceAlive(rs, { dockerRunning: async () => true, pidAlive: () => false })).toBe(true);
  expect(await isInstanceAlive(rs, { dockerRunning: async () => false, pidAlive: () => true })).toBe(false);
});

test("isInstanceAlive: pid path when no container", async () => {
  const rs: RunState = { project: "p", slug: "s", branch: "b", port: 1, pid: 123, container: null, started: 0, pgroup: false };
  expect(await isInstanceAlive(rs, { dockerRunning: async () => false, pidAlive: () => true })).toBe(true);
  expect(await isInstanceAlive(rs, { dockerRunning: async () => false, pidAlive: () => false })).toBe(false);
});

test("formatRunState (docker shape) matches cmd_start key order", () => {
  expect(
    formatRunState({ container: "wtdev-apartx-apple-x", port: 3701, branch: "feature/x", started: 1700000000, project: "apartx-apple", slug: "x" }),
  ).toBe("container=wtdev-apartx-apple-x\nport=3701\nbranch=feature/x\nstarted=1700000000\nproject=apartx-apple\nslug=x\n");
});

test("formatRunState (host shape) appends pgroup=1", () => {
  expect(
    formatRunState({ pid: 4242, port: 3701, branch: "feature/x", started: 1700000000, project: "apartx-help", slug: "x", pgroup: true }),
  ).toBe("pid=4242\nport=3701\nbranch=feature/x\nstarted=1700000000\nproject=apartx-help\nslug=x\npgroup=1\n");
});

test("stopDecision: container → docker rm regardless of alive", () => {
  const rs: RunState = { project: "p", slug: "s", branch: "b", port: 1, pid: null, container: "c", started: 0, pgroup: false };
  expect(stopDecision(rs, false)).toEqual({ kind: "container", container: "c" });
});

test("stopDecision: live host pid → kill tree with pgroup", () => {
  const rs: RunState = { project: "p", slug: "s", branch: "b", port: 1, pid: 99, container: null, started: 0, pgroup: true };
  expect(stopDecision(rs, true)).toEqual({ kind: "pid", pid: 99, pgroup: true });
});

test("stopDecision: dead host pid → cleanup only", () => {
  const rs: RunState = { project: "p", slug: "s", branch: "b", port: 1, pid: 99, container: null, started: 0, pgroup: false };
  expect(stopDecision(rs, false)).toEqual({ kind: "cleanup" });
});

it("renames <project>-main.* run-state artifacts to -base.*", async () => {
  const orch = mkdtempSync(join(tmpdir(), "wt-"));
  const rd = resolve(orch, "var", "run");
  await mkdir(rd, { recursive: true });
  await writeFile(resolve(rd, "apartx-server-main.run"), "PID=1\n");
  await writeFile(resolve(rd, "apartx-server-main.log"), "log\n");
  await writeFile(resolve(rd, "apartx-cabinet-eu-x.run"), "PID=2\n"); // feature slug — untouched
  const moved = await migrateBaseSlugArtifacts(orch);
  const files = (await readdir(rd)).sort();
  expect(files).toEqual(["apartx-cabinet-eu-x.run", "apartx-server-base.log", "apartx-server-base.run"]);
  expect(moved).toContain("apartx-server-main.run");
});

it("does not clobber an existing -base.* target", async () => {
  const orch = mkdtempSync(join(tmpdir(), "wt-"));
  const rd = resolve(orch, "var", "run");
  await mkdir(rd, { recursive: true });
  await writeFile(resolve(rd, "apartx-server-main.run"), "PID=1\n");
  await writeFile(resolve(rd, "apartx-server-base.run"), "PID=base\n");
  const moved = await migrateBaseSlugArtifacts(orch);
  const files = (await readdir(rd)).sort();
  expect(files).toEqual(["apartx-server-base.run", "apartx-server-main.run"]);
  expect(moved).toEqual([]);
});

it("does not migrate <project>-main.* when a real feature/main worktree exists", async () => {
  const orch = mkdtempSync(join(tmpdir(), "wt-"));
  const rd = resolve(orch, "var", "run");
  await mkdir(rd, { recursive: true });
  await writeFile(resolve(rd, "apartx-server-main.run"), "PID=1\n");
  // a real `wt new apartx-server main` worktree → worktrees/<p>/main exists
  await mkdir(resolve(orch, "worktrees", "apartx-server", "main"), { recursive: true });
  const moved = await migrateBaseSlugArtifacts(orch);
  const files = (await readdir(rd)).sort();
  expect(files).toEqual(["apartx-server-main.run"]); // stays -main
  expect(moved).toEqual([]);
});

it("is a no-op when there are no -main.* artifacts", async () => {
  const orch = mkdtempSync(join(tmpdir(), "wt-"));
  expect(await migrateBaseSlugArtifacts(orch)).toEqual([]);
});
