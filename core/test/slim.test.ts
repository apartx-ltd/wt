import { test, expect } from "bun:test";
import { classifySlim, findOrphanVolumes, type SlimFacts } from "../src/slim";

const base: SlimFacts = {
  running: false,
  dirs: [{ path: "/orch/worktrees/apartx-cabinet/ai-title/node_modules", bytes: 1024 }],
  volumes: ["wtdev-apartx-cabinet-ai-title-node_modules"],
};

test("остановлен, есть каталоги и тома → slim", () => {
  expect(classifySlim(base)).toEqual({ action: "slim", reason: "slim" });
});

test("запущен → skip running, даже с артефактами", () => {
  expect(classifySlim({ ...base, running: true })).toEqual({ action: "skip", reason: "running" });
});

test("только тома (host-каталогов нет) → slim", () => {
  expect(classifySlim({ ...base, dirs: [] })).toEqual({ action: "slim", reason: "slim" });
});

test("только host-каталоги (не dockerized) → slim", () => {
  expect(classifySlim({ ...base, volumes: [] })).toEqual({ action: "slim", reason: "slim" });
});

test("нечего сносить → skip clean", () => {
  expect(classifySlim({ ...base, dirs: [], volumes: [] })).toEqual({ action: "skip", reason: "clean" });
});

test("сироты: wtdev-тома, которых нет среди томов существующих worktree и base", () => {
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
