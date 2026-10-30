import { test, expect } from "bun:test";
import { WT_PROTOCOL_VERSION } from "#shared";
import { ensureServer, type BootDeps } from "../src/server-boot";

const OPTS = { port: 4599, serverEntry: "/dev/null" };
const noSleep = () => Promise.resolve();

test("reuses a current server (no kill, no spawn)", async () => {
  let killed = false;
  let spawned = false;
  const deps: BootDeps = {
    fetchVersion: async () => WT_PROTOCOL_VERSION,
    isWtServer: async () => true,
    killPort: async () => { killed = true; },
    spawnServer: () => { spawned = true; return undefined; },
    sleep: noSleep,
  };
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
  const deps: BootDeps = {
    fetchVersion: async () => (fresh ? WT_PROTOCOL_VERSION : null),
    isWtServer: async () => true, // an old server answers /api/instances
    killPort: async () => { killed = true; },
    spawnServer: () => { spawnCalls++; fresh = true; return undefined; },
    sleep: noSleep,
  };
  const res = await ensureServer(OPTS, deps);
  expect(killed).toBe(true);
  expect(res.replaced).toBe(true);
  expect(spawnCalls).toBe(1);
});

test("spawns fresh when nothing is listening (no kill)", async () => {
  let killed = false;
  let fresh = false;
  const deps: BootDeps = {
    fetchVersion: async () => (fresh ? WT_PROTOCOL_VERSION : null),
    isWtServer: async () => false, // nothing on the port
    killPort: async () => { killed = true; },
    spawnServer: () => { fresh = true; return undefined; },
    sleep: noSleep,
  };
  const res = await ensureServer(OPTS, deps);
  expect(killed).toBe(false);
  expect(res.replaced).toBe(false);
});

test("passes staticDir through to the spawned server", async () => {
  let fresh = false;
  let spawnedWith: string | undefined;
  const deps: BootDeps = {
    fetchVersion: async () => (fresh ? WT_PROTOCOL_VERSION : null),
    isWtServer: async () => false,
    killPort: async () => {},
    spawnServer: (_port, _entry, staticDir) => { spawnedWith = staticDir; fresh = true; return undefined; },
    sleep: noSleep,
  };
  await ensureServer({ ...OPTS, staticDir: "/srv/wt/web/build" }, deps);
  expect(spawnedWith).toBe("/srv/wt/web/build");
});
