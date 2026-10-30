/**
 * End-to-end interaction check for the dashboard actions and modals.
 *
 * Run with `bun` (NOT `bun test`): `bun run e2e` from the repo root (the root bunfig.toml preloads @opentui/solid).
 * `bun test` resolves solid-js to its "node"/SSR build (orphan-text crash in the
 * universal renderer); `bun <script>` resolves the client build the real `wt ui`
 * uses. So this lives outside the bun-test glob (`.e2e.tsx`) and self-asserts.
 */
import { testRender } from "@opentui/solid";
import { App } from "../src/app";
import type { MergedInstance } from "#shared";

const tick = async (t: any, ms = 35) => {
  await new Promise((r) => setTimeout(r, ms));
  await t.renderOnce();
};

const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` — got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
  return ok;
};

const calls: Record<string, any> = {};
const insts: MergedInstance[] = [
  { project: "p", slug: "base", branch: "main", port: 4000, status: "down", pid: null, container: null, started: null },
  { project: "p", slug: "feat-a", branch: "feature/feat-a", port: 4001, status: "up", pid: 1, container: "c", started: 0 },
];
const stub: any = {
  listInstances: async () => insts,
  subscribe: () => () => {},
  streamLogs: () => () => {},
  start: async (p: string, s: string) => ((calls.start = { p, s }), { ok: true }),
  stop: async () => ({ code: 0 }),
  restart: async () => ({ ok: true }),
  link: async (p: string, s: string, ls?: string) => ((calls.link = { p, s, ls }), { code: 0 }),
  unlink: async (p: string, s: string) => ((calls.unlink = { p, s }), { code: 0 }),
  listProjects: async () => ["p"],
  newWorktree: async (a: any) => ((calls.new = a), { ok: true }),
  rmWorktree: async (p: string, s: string, b: boolean) => ((calls.rm = { p, s, b }), { code: 0 }),
};

const t: any = await testRender(() => <App client={stub} />, { width: 90, height: 26 });
await tick(t, 60);

const results: boolean[] = [];

// base-checkout guard: the base row (slug "base") is selected at startup; pressing the
// rm key ('d') must NOT open the confirm modal nor invoke rm — the guard rejects it.
await t.mockInput.pressKeys(["d"]);
await tick(t);
results.push(eq("rm base rejected (guard)", calls.rm, undefined));

// select the feature instance, then start it
t.mockInput.pressArrow("down");
await tick(t);
await t.mockInput.pressKeys(["s"]);
await tick(t);
results.push(eq("start feat-a", calls.start, { p: "p", s: "feat-a" }));

// link: 'l' opens modal, Enter submits default (== slug → undefined arg)
await t.mockInput.pressKeys(["l"]);
await tick(t, 50);
t.mockInput.pressEnter();
await tick(t);
results.push(eq("link feat-a", calls.link, { p: "p", s: "feat-a", ls: undefined }));

// unlink: direct action
await t.mockInput.pressKeys(["u"]);
await tick(t);
results.push(eq("unlink feat-a", calls.unlink, { p: "p", s: "feat-a" }));

// new worktree: navigate + edit slug + create
await t.mockInput.pressKeys(["n"]);
await tick(t, 50);
t.mockInput.pressArrow("down"); // -> slug
await tick(t);
t.mockInput.pressEnter(); // edit mode
await tick(t);
await t.mockInput.typeText("brand-new");
await tick(t);
t.mockInput.pressEnter(); // exit edit
await tick(t);
t.mockInput.pressArrow("down"); // -> --isolated-db
await tick(t);
t.mockInput.pressArrow("down"); // -> --seed
await tick(t);
t.mockInput.pressArrow("down"); // -> Create
await tick(t);
t.mockInput.pressEnter();
await tick(t);
results.push(eq("new brand-new", calls.new, { project: "p", slug: "brand-new", isolatedDb: false, seed: false }));

// remove: 'd' opens confirm, 'y' confirms without dropping branch
await t.mockInput.pressKeys(["d"]);
await tick(t);
await t.mockInput.pressKeys(["y"]);
await tick(t);
results.push(eq("rm feat-a", calls.rm, { p: "p", s: "feat-a", b: false }));

const passed = results.every(Boolean);
console.log(passed ? "\nPASS (all actions)" : "\nFAIL");
process.exit(passed ? 0 : 1);
