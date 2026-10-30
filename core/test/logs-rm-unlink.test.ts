import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { resolveLogSource, listLogFiles } from "../src/run";
import { removeLinks } from "../src/links";
import { removeWorktree } from "../src/new-worktree";
import { ovrFilePath, envFilePath } from "../src/paths";

function mkOrch(): string {
  const orch = mkdtempSync(resolve(tmpdir(), "wt-lru-"));
  mkdirSync(resolve(orch, "var", "run"), { recursive: true });
  mkdirSync(resolve(orch, "var", "settings"), { recursive: true });
  mkdirSync(resolve(orch, "var", "env"), { recursive: true });
  return orch;
}

test("resolveLogSource: dockerized runfile → docker logs", async () => {
  const orch = mkOrch();
  try {
    writeFileSync(resolve(orch, "var", "run", "apartx-server-feat.run"), "container=wtdev-apartx-server-feat\nproject=apartx-server\nslug=feat\n");
    expect(await resolveLogSource(orch, "apartx-server", "feat")).toEqual({ kind: "docker", container: "wtdev-apartx-server-feat" });
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("resolveLogSource: host logfile present (no container)", async () => {
  const orch = mkOrch();
  try {
    writeFileSync(resolve(orch, "var", "run", "apartx-help-x.log"), "boot\n");
    const r = await resolveLogSource(orch, "apartx-help", "x");
    expect(r).toEqual({ kind: "file", path: resolve(orch, "var", "run", "apartx-help-x.log") });
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("resolveLogSource: nothing → null", async () => {
  const orch = mkOrch();
  try {
    expect(await resolveLogSource(orch, "nope", "nope")).toBeNull();
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("listLogFiles: one .log per .run, sorted", async () => {
  const orch = mkOrch();
  try {
    writeFileSync(resolve(orch, "var", "run", "b-x.run"), "");
    writeFileSync(resolve(orch, "var", "run", "a-y.run"), "");
    expect(await listLogFiles(orch)).toEqual([
      resolve(orch, "var", "run", "a-y.log"),
      resolve(orch, "var", "run", "b-x.log"),
    ]);
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("removeLinks: deletes ovr + env layer files (idempotent)", async () => {
  const orch = mkOrch();
  try {
    writeFileSync(ovrFilePath(orch, "apartx-cabinet", "x"), "{}");
    writeFileSync(envFilePath(orch, "apartx-cabinet", "x"), "SERVER_URL=...");
    await removeLinks(orch, "apartx-cabinet", "x");
    expect(existsSync(ovrFilePath(orch, "apartx-cabinet", "x"))).toBe(false);
    expect(existsSync(envFilePath(orch, "apartx-cabinet", "x"))).toBe(false);
    await removeLinks(orch, "apartx-cabinet", "x"); // no throw when absent
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("removeWorktree: rejects base slug", async () => {
  const orch = mkOrch();
  try {
    expect(removeWorktree(orch, "apartx-server", "base")).rejects.toThrow(/base checkout/);
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("removeWorktree: rejects missing project", async () => {
  const orch = mkOrch();
  try {
    expect(removeWorktree(orch, "ghost", "x")).rejects.toThrow(/no such project/);
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});
