import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { WT_PROTOCOL_VERSION } from "#shared";
import { ensureServer, type BootDeps } from "../src/server-boot";

const ORCH = mkdtempSync(resolve(tmpdir(), "wt-boot-orch-"));
const OTHER_ORCH = mkdtempSync(resolve(tmpdir(), "wt-boot-other-"));
// A built dashboard (index.html present) for the static-dir checks.
const BUILD = mkdtempSync(resolve(tmpdir(), "wt-boot-build-"));
writeFileSync(resolve(BUILD, "index.html"), "<!doctype html>");
const NO_BUILD = resolve(BUILD, "missing");
mkdirSync(resolve(BUILD, "empty"));

afterAll(() => {
  for (const d of [ORCH, OTHER_ORCH, BUILD]) rmSync(d, { recursive: true, force: true });
});

const OPTS = { port: 4599, serverEntry: "/dev/null", orch: ORCH };
const noSleep = () => Promise.resolve();

/** A daemon that is current and serves ORCH; override per test. */
function currentDeps(over: Partial<BootDeps> = {}): BootDeps {
  return {
    fetchVersion: async () => WT_PROTOCOL_VERSION,
    fetchMeta: async () => ({ title: null, orch: ORCH }),
    fetchRootStatus: async () => 200,
    isWtServer: async () => true,
    killPort: async () => {},
    spawnServer: () => undefined,
    sleep: noSleep,
    ...over,
  };
}

test("reuses a current server (no kill, no spawn)", async () => {
  let killed = false;
  let spawned = false;
  const deps = currentDeps({
    killPort: async () => { killed = true; },
    spawnServer: () => { spawned = true; return undefined; },
  });
  const res = await ensureServer(OPTS, deps);
  expect(res.replaced).toBe(false);
  expect(res.spawned).toBeUndefined();
  expect(killed).toBe(false);
  expect(spawned).toBe(false);
});

test("replaces a stale wt-server (kill + respawn) — the log-pane regression", async () => {
  let killed = false;
  let spawnCalls = 0;
  // Stale server: /health absent (null) until we spawn a fresh one, which then reports current.
  let fresh = false;
  const deps = currentDeps({
    fetchVersion: async () => (fresh ? WT_PROTOCOL_VERSION : null),
    isWtServer: async () => true, // an old server answers /api/instances
    killPort: async () => { killed = true; },
    spawnServer: () => { spawnCalls++; fresh = true; return undefined; },
  });
  const res = await ensureServer(OPTS, deps);
  expect(killed).toBe(true);
  expect(res.replaced).toBe(true);
  expect(spawnCalls).toBe(1);
});

test("spawns fresh when nothing is listening (no kill)", async () => {
  let killed = false;
  let fresh = false;
  const deps = currentDeps({
    fetchVersion: async () => (fresh ? WT_PROTOCOL_VERSION : null),
    isWtServer: async () => false, // nothing on the port
    killPort: async () => { killed = true; },
    spawnServer: () => { fresh = true; return undefined; },
  });
  const res = await ensureServer(OPTS, deps);
  expect(killed).toBe(false);
  expect(res.replaced).toBe(false);
});

test("passes orch and staticDir through to the spawned server", async () => {
  let fresh = false;
  let spawnedWith: { orch: string; staticDir?: string } | undefined;
  const deps = currentDeps({
    fetchVersion: async () => (fresh ? WT_PROTOCOL_VERSION : null),
    isWtServer: async () => false,
    spawnServer: (o) => { spawnedWith = { orch: o.orch, staticDir: o.staticDir }; fresh = true; return undefined; },
  });
  await ensureServer({ ...OPTS, staticDir: "/srv/wt/web/build" }, deps);
  expect(spawnedWith).toEqual({ orch: ORCH, staticDir: "/srv/wt/web/build" });
});

test("replaces a current server that drives a different workspace", async () => {
  let killed = false;
  let spawnedOrch: string | undefined;
  let served = OTHER_ORCH;
  const deps = currentDeps({
    fetchMeta: async () => ({ title: null, orch: served }),
    killPort: async () => { killed = true; },
    spawnServer: (o) => { spawnedOrch = o.orch; served = o.orch; return undefined; },
  });
  const res = await ensureServer(OPTS, deps);
  expect(killed).toBe(true);
  expect(res.replaced).toBe(true);
  expect(spawnedOrch).toBe(ORCH);
});

test("replaces a current server whose /api/meta has no orch (pre-binding build)", async () => {
  let killed = false;
  const deps = currentDeps({
    fetchMeta: async () => ({ title: null }),
    killPort: async () => { killed = true; },
  });
  const res = await ensureServer(OPTS, deps);
  expect(killed).toBe(true);
  expect(res.replaced).toBe(true);
});

test("same workspace via a non-canonical path is reused", async () => {
  let killed = false;
  const deps = currentDeps({ killPort: async () => { killed = true; } });
  const res = await ensureServer({ ...OPTS, orch: `${ORCH}/./` }, deps);
  expect(killed).toBe(false);
  expect(res.replaced).toBe(false);
});

test("replaces a current server that 404s / when a built staticDir is requested", async () => {
  let killed = false;
  let spawnedStatic: string | undefined;
  let rootStatus = 404; // started without WT_STATIC_DIR
  const deps = currentDeps({
    fetchRootStatus: async () => rootStatus,
    killPort: async () => { killed = true; },
    spawnServer: (o) => { spawnedStatic = o.staticDir; rootStatus = 200; return undefined; },
  });
  const res = await ensureServer({ ...OPTS, staticDir: BUILD }, deps);
  expect(killed).toBe(true);
  expect(res.replaced).toBe(true);
  expect(spawnedStatic).toBe(BUILD);
});

test("a 404 on / is not stale when the static build is absent or not requested", async () => {
  for (const staticDir of [undefined, NO_BUILD, resolve(BUILD, "empty")]) {
    let killed = false;
    const deps = currentDeps({
      fetchRootStatus: async () => 404,
      killPort: async () => { killed = true; },
    });
    const res = await ensureServer({ ...OPTS, staticDir }, deps);
    expect(killed).toBe(false);
    expect(res.replaced).toBe(false);
  }
});
