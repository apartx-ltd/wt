import { test, expect } from "bun:test";
import { classifySlim, findOrphanVolumes, type SlimFacts } from "../src/slim";

const base: SlimFacts = {
  running: false,
  dirs: [{ path: "/orch/worktrees/apartx-cabinet/ai-title/node_modules", bytes: 1024 }],
  volumes: ["wtdev-apartx-cabinet-ai-title-node_modules"],
};

test("stopped, has directories and volumes → slim", () => {
  expect(classifySlim(base)).toEqual({ action: "slim", reason: "slim" });
});

test("running → skip running, even with artifacts", () => {
  expect(classifySlim({ ...base, running: true })).toEqual({ action: "skip", reason: "running" });
});

test("volumes only (no host directories) → slim", () => {
  expect(classifySlim({ ...base, dirs: [] })).toEqual({ action: "slim", reason: "slim" });
});

test("host directories only (not dockerized) → slim", () => {
  expect(classifySlim({ ...base, volumes: [] })).toEqual({ action: "slim", reason: "slim" });
});

test("nothing to remove → skip clean", () => {
  expect(classifySlim({ ...base, dirs: [], volumes: [] })).toEqual({ action: "skip", reason: "clean" });
});

test("orphans: wtdev volumes absent from the volumes of existing worktrees and base", () => {
  const owned = new Set([
    "wtdev-apartx-server-base-node_modules",
    "wtdev-apartx-server-ai-tasks-node_modules",
  ]);
  expect(findOrphanVolumes([
    "wtdev-apartx-server-base-node_modules",
    "wtdev-apartx-server-ai-tasks-node_modules",
    "wtdev-apartx-server-property-season-meteor_local",
    "apartx_nats_data",
    "meteor_base",
  ], owned)).toEqual(["wtdev-apartx-server-property-season-meteor_local"]);
});
