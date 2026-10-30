import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { reapContainers, type ReapActions } from "../src/run";

function orchWith(runfiles: Record<string, string>): string {
  const orch = mkdtempSync(resolve(tmpdir(), "wt-reap-"));
  mkdirSync(resolve(orch, "var", "run"), { recursive: true });
  for (const [name, body] of Object.entries(runfiles)) writeFileSync(resolve(orch, "var", "run", name), body);
  return orch;
}

test("reapContainers: rm dev containers + cleans only container runfiles", async () => {
  const orch = orchWith({
    "apartx-server-a.run": "container=wtdev-apartx-server-a\nproject=apartx-server\nslug=a\n",
    "apartx-help-b.run": "pid=123\nproject=apartx-help\nslug=b\npgroup=1\n", // host: keep
  });
  try {
    const removed: string[][] = [];
    const actions: ReapActions = {
      listDevContainers: async () => ["wtdev-apartx-server-a"],
      removeContainers: async (ids) => void removed.push(ids),
    };
    const r = await reapContainers(orch, actions);
    expect(r).toEqual({ removed: 1 });
    expect(removed).toEqual([["wtdev-apartx-server-a"]]);
    expect(existsSync(resolve(orch, "var", "run", "apartx-server-a.run"))).toBe(false); // container runfile gone
    expect(existsSync(resolve(orch, "var", "run", "apartx-help-b.run"))).toBe(true); // host runfile kept
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("reapContainers: nothing to reap → removed 0, no removeContainers call", async () => {
  const orch = orchWith({});
  try {
    let called = false;
    const actions: ReapActions = {
      listDevContainers: async () => [],
      removeContainers: async () => void (called = true),
    };
    expect(await reapContainers(orch, actions)).toEqual({ removed: 0 });
    expect(called).toBe(false);
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});
