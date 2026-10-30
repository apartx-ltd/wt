/**
 * Regression: a wheel scroll over the instance list must keep the selection cursor (▸)
 * in view. The list is selection-driven — the wheel moves the SELECTION, and scrollTop
 * is derived from it. The bug was the scrollbox ALSO scrolling itself natively (a second
 * scrollTop writer racing the selection effect), so the view slid off the cursor.
 *
 * Run with `bun test/scroll.e2e.tsx` (NOT `bun test`): `bun test` resolves solid-js to its
 * SSR build and the universal renderer crashes. So this lives outside the bun-test glob
 * (`.e2e.tsx`) and self-asserts. See flow.e2e.tsx for the same constraint.
 */
import { testRender } from "@opentui/solid";
import { App } from "../src/app";
import type { MergedInstance } from "#shared";

const tick = async (t: any, ms = 35) => {
  await new Promise((r) => setTimeout(r, ms));
  await t.renderOnce();
};

const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` — ${detail}`}`);
  return ok;
};

// 40 worktree rows + 1 base → overflows the list viewport at any reasonable height.
const insts: MergedInstance[] = [];
for (let i = 0; i < 40; i++) {
  insts.push({
    project: "p", slug: `wt${String(i).padStart(2, "0")}`, branch: `feature/wt${i}`,
    port: 4001 + i, status: "up", pid: 1, container: "c", started: 0,
  });
}
insts.push({ project: "p", slug: "base", branch: "main", port: 4000, status: "down", pid: null, container: null, started: null });

const stub: any = {
  listInstances: async () => insts,
  getMeta: async () => ({ title: "test" }),
  subscribe: () => () => {},
  streamLogs: () => () => {},
};

const t: any = await testRender(() => <App client={stub} />, { width: 90, height: 24 });
await tick(t, 80);

const results: boolean[] = [];

// The cursor starts on the first row (wt00). Find its rendered line to scroll over it.
const frame0: string = t.captureCharFrame();
const y = frame0.split("\n").findIndex((l: string) => l.includes("wt00"));
results.push(check("list rendered: wt00 visible, cursor present", y >= 0 && frame0.includes("▸"), `y=${y}`));

// Scroll the wheel down 25 times over the list region. Each tick moves the selection by
// one row, so the cursor lands on wt25 — well past the first viewport.
for (let k = 0; k < 25; k++) await t.mockMouse.scroll(10, Math.max(y, 3), "down");
await tick(t, 60);

const frame1: string = t.captureCharFrame();
const cursorLine = frame1.split("\n").find((l: string) => l.includes("▸")) ?? "";
results.push(check("cursor still visible after scroll", frame1.includes("▸"), "no ▸ in frame"));
results.push(check("view scrolled: wt00 left the viewport", !frame1.includes("wt00"), "wt00 still shown"));
results.push(check("cursor sits on the scrolled-to row wt25", cursorLine.includes("wt25"), `cursorLine="${cursorLine.trim()}"`));

// Scroll back up to the top; the cursor must ride back into view and land on wt00.
for (let k = 0; k < 30; k++) await t.mockMouse.scroll(10, Math.max(y, 3), "up");
await tick(t, 60);
const frame2: string = t.captureCharFrame();
const cursorLine2 = frame2.split("\n").find((l: string) => l.includes("▸")) ?? "";
results.push(check("after scrolling up, cursor visible on wt00", frame2.includes("▸") && cursorLine2.includes("wt00"), `cursorLine="${cursorLine2.trim()}"`));

const passed = results.every(Boolean);
console.log(passed ? "\nPASS (wheel keeps cursor in view)" : "\nFAIL");
process.exit(passed ? 0 : 1);
