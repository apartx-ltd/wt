import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DEFAULT_STORAGE_DIR, volumeDir, storageSource, applyStorage, ensureVolumeDirs } from "../src/storage";

test("volumeDir: under var/volumes by default, under storageDir (relative to the workspace or absolute) when set", () => {
  expect(DEFAULT_STORAGE_DIR).toBe("var/volumes");
  expect(volumeDir("/orch", "wtdev-p-s-node_modules")).toBe("/orch/var/volumes/wtdev-p-s-node_modules");
  expect(volumeDir("/orch", "wtdev-p-s-node_modules", "./cache/volumes")).toBe("/orch/cache/volumes/wtdev-p-s-node_modules");
  expect(volumeDir("/orch", "wtdev-p-s-node_modules", "/fast/wt-volumes")).toBe("/fast/wt-volumes/wtdev-p-s-node_modules");
});

test("storageSource: the volume name in volume mode, the directory in dir mode", () => {
  expect(storageSource("/orch", "wtdev-p-s-target", "volume")).toBe("wtdev-p-s-target");
  expect(storageSource("/orch", "wtdev-p-s-target", "dir")).toBe("/orch/var/volumes/wtdev-p-s-target");
  expect(storageSource("/orch", "wtdev-p-s-target", "dir", "/fast")).toBe("/fast/wtdev-p-s-target");
});

test("applyStorage rewrites only owned sources, and only in dir mode", () => {
  const mounts = ["/wt:/opt/app", "wtdev-p-s-node_modules:/opt/app/node_modules", "meteor_base:/root"];
  expect(applyStorage(mounts, ["wtdev-p-s-node_modules"], "dir", "/orch"))
    .toEqual(["/wt:/opt/app", "/orch/var/volumes/wtdev-p-s-node_modules:/opt/app/node_modules", "meteor_base:/root"]);
  expect(applyStorage(mounts, ["wtdev-p-s-node_modules"], "volume", "/orch")).toEqual(mounts);
  expect(applyStorage(mounts, ["wtdev-p-s-node_modules"], "dir", "/orch", "/fast/wt-volumes")[1])
    .toBe("/fast/wt-volumes/wtdev-p-s-node_modules:/opt/app/node_modules");
  expect(applyStorage(mounts, ["wtdev-p-s-node_modules"], "dir", "/orch", "./cache/volumes")[1])
    .toBe("/orch/cache/volumes/wtdev-p-s-node_modules:/opt/app/node_modules");
});

test("ensureVolumeDirs creates <storageDir>/<name> in dir mode and nothing in volume mode", async () => {
  const orch = mkdtempSync(resolve(tmpdir(), "wt-storage-"));
  try {
    await ensureVolumeDirs(orch, ["wtdev-p-s-node_modules"], "volume");
    expect(existsSync(resolve(orch, "var", "volumes"))).toBe(false);
    await ensureVolumeDirs(orch, ["wtdev-p-s-node_modules"], "dir");
    expect(statSync(resolve(orch, "var", "volumes", "wtdev-p-s-node_modules")).isDirectory()).toBe(true);
    await ensureVolumeDirs(orch, ["wtdev-p-s-target"], "dir", "./cache/volumes");
    expect(statSync(resolve(orch, "cache", "volumes", "wtdev-p-s-target")).isDirectory()).toBe(true);
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});
