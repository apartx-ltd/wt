import { test, expect } from "bun:test";
import { resolve } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
const DOCKERIZED = ["apartx-server", "apartx-cabinet", "apartx-admin"];
import {
  resolveBasePort,
  deterministicAuxBasePort,
  resolveAuxBasePort,
  parseLedger,
  allocateOffset,
  appendLedger,
  upsertLedger,
  readLedger,
  isBlockedPort,
  BLOCKED_PORTS,
  STEP,
  type LedgerRow,
} from "../src/ports";
import type { ExtraPortSpec } from "../src/plugin";

const fx = (p: string) => resolve(import.meta.dir, "fixtures/ports", p);
const HMR: ExtraPortSpec = { name: "hmr", basePort: 8085, envKey: "RSPACK_DEVSERVER_PORT" };

test("STEP is 10 (parity with worktree-env.sh)", () => {
  expect(STEP).toBe(10);
});

test("resolveBasePort reads PORT from .env", async () => {
  expect(await resolveBasePort(fx("with-env"))).toBe(4000);
});

test("resolveBasePort falls back to package.json --port", async () => {
  expect(await resolveBasePort(fx("pkg-only"))).toBe(3900);
});

test("resolveBasePort returns null when nothing found", async () => {
  expect(await resolveBasePort(fx("does-not-exist"))).toBeNull();
});

test("parseLedger parses tab-separated rows", () => {
  const rows = parseLedger("a\tfeature/x\t10\nb\tfeature/y\t30\n");
  expect(rows).toEqual([
    { project: "a", branch: "feature/x", offset: 10 },
    { project: "b", branch: "feature/y", offset: 30 },
  ]);
});

test("parseLedger ignores blank/short lines", () => {
  expect(parseLedger("\n\na\tb\t10\nbroken-line\n")).toEqual([
    { project: "a", branch: "b", offset: 10 },
  ]);
});

test("allocateOffset returns existing offset for known branch", () => {
  const led: LedgerRow[] = [{ project: "a", branch: "feat", offset: 50 }];
  expect(allocateOffset(led, "a", "feat")).toBe(50);
});

test("allocateOffset fills the lowest free n*STEP slot globally", () => {
  const led: LedgerRow[] = [
    { project: "a", branch: "x", offset: 10 },
    { project: "b", branch: "y", offset: 30 },
  ];
  expect(allocateOffset(led, "c", "z")).toBe(20);
});

test("allocateOffset starts at STEP when ledger empty", () => {
  expect(allocateOffset([], "a", "b")).toBe(10);
});

test("allocateOffset skips contiguous taken slots", () => {
  const led: LedgerRow[] = [
    { project: "a", branch: "x", offset: 10 },
    { project: "a", branch: "y", offset: 20 },
    { project: "a", branch: "z", offset: 30 },
  ];
  expect(allocateOffset(led, "a", "w")).toBe(40);
});

// --- BLOCKED_PORTS: 5000/7000 are held by the system ControlCenter (AirPlay) ---

test("isBlockedPort covers the macOS AirPlay pair and nothing else", () => {
  expect(BLOCKED_PORTS).toEqual([5000, 7000]);
  expect(isBlockedPort(7000)).toBe(true);
  expect(isBlockedPort(5000)).toBe(true);
  expect(isBlockedPort(6999)).toBe(false);
});

test("allocateOffset skips an offset that lands on a blocked port", () => {
  // basePort 4000: offset 3000 would give 7000 — take the next free one.
  expect(allocateOffset([], "a", "b", 4000)).toBe(10);
  const led: LedgerRow[] = Array.from({ length: 299 }, (_, i) => ({
    project: "a", branch: `b${i}`, offset: (i + 1) * STEP,
  }));
  expect(allocateOffset(led, "a", "new", 4000)).toBe(3010);
});

test("allocateOffset moves a known branch off a blocked port", () => {
  const led: LedgerRow[] = [{ project: "apartx-server", branch: "feat", offset: 3000 }];
  expect(allocateOffset(led, "apartx-server", "feat", 4000)).toBe(10);
  // Without basePort the behavior is unchanged — the existing offset is returned as is.
  expect(allocateOffset(led, "apartx-server", "feat")).toBe(3000);
});

test("allocateOffset keeps a known branch whose port is fine", () => {
  const led: LedgerRow[] = [{ project: "a", branch: "feat", offset: 50 }];
  expect(allocateOffset(led, "a", "feat", 4000)).toBe(50);
});

test("upsertLedger replaces the row instead of duplicating it", async () => {
  const orch = mkdtempSync(resolve(tmpdir(), "wt-ledger-"));
  try {
    await appendLedger(orch, "a", "x", 10);
    await appendLedger(orch, "b", "y", 20);
    await upsertLedger(orch, "a", "x", 40);
    const rows = await readLedger(orch);
    expect(rows).toEqual([
      { project: "a", branch: "x", offset: 40 },
      { project: "b", branch: "y", offset: 20 },
    ]);
    await upsertLedger(orch, "c", "z", 60);
    expect(await readLedger(orch)).toHaveLength(3);
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("appendLedger creates var/ + file and round-trips via readLedger", async () => {
  const orch = mkdtempSync(resolve(tmpdir(), "wt-ledger-"));
  try {
    await appendLedger(orch, "apartx-server", "feature/a", 10);
    await appendLedger(orch, "apartx-cabinet", "feature/b", 20);
    expect(await readLedger(orch)).toEqual([
      { project: "apartx-server", branch: "feature/a", offset: 10 },
      { project: "apartx-cabinet", branch: "feature/b", offset: 20 },
    ]);
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("readLedger returns [] when ledger absent", async () => {
  expect(await readLedger("/tmp/no-orch-xyz")).toEqual([]);
});

test("deterministicAuxBasePort is stable and dockerized-indexed (8085 + sorted idx)", () => {
  // sorted: admin(0), cabinet(1), server(2)
  expect(deterministicAuxBasePort("apartx-admin", 8085, DOCKERIZED)).toBe(8085);
  expect(deterministicAuxBasePort("apartx-cabinet", 8085, DOCKERIZED)).toBe(8086);
  expect(deterministicAuxBasePort("apartx-server", 8085, DOCKERIZED)).toBe(8087);
});

test("deterministicAuxBasePort throws for a project outside the dockerized set", () => {
  expect(() => deterministicAuxBasePort("apartx-spaces", 8085, DOCKERIZED)).toThrow(/is not among the config's dockerized/);
});

test("resolveAuxBasePort prefers the env-override (spec.envKey) over the deterministic base", async () => {
  // fixture with-env has RSPACK_DEVSERVER_PORT=9000 — explicit value wins, not 8085+idx.
  expect(await resolveAuxBasePort(fx("with-env"), "apartx-server", HMR, DOCKERIZED)).toBe(9000);
});

test("resolveAuxBasePort falls back to deterministic when env-override absent", async () => {
  const server = await resolveAuxBasePort(fx("without-hmr"), "apartx-server", HMR, DOCKERIZED);
  const admin = await resolveAuxBasePort(fx("without-hmr"), "apartx-admin", HMR, DOCKERIZED);
  const cabinet = await resolveAuxBasePort(fx("without-hmr"), "apartx-cabinet", HMR, DOCKERIZED);
  expect(server).toBe(deterministicAuxBasePort("apartx-server", 8085, DOCKERIZED));
  expect(admin).toBe(deterministicAuxBasePort("apartx-admin", 8085, DOCKERIZED));
  expect(cabinet).toBe(deterministicAuxBasePort("apartx-cabinet", 8085, DOCKERIZED));
});

test("resolveAuxBasePort ignores invalid env value and falls back", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "wt-hmr-invalid-"));
  try {
    writeFileSync(resolve(dir, ".env"), "RSPACK_DEVSERVER_PORT=not-a-port\n");
    expect(await resolveAuxBasePort(dir, "apartx-server", HMR, DOCKERIZED)).toBe(deterministicAuxBasePort("apartx-server", 8085, DOCKERIZED));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deterministicAuxBasePort is unique across all DOCKERIZED projects", () => {
  const bases = DOCKERIZED.map((p) => deterministicAuxBasePort(p, 8085, DOCKERIZED));
  expect(new Set(bases).size).toBe(DOCKERIZED.length);
});

test("allocateOffset uses the given step (multiples of step, gaps filled)", () => {
  expect(allocateOffset([], "a", "b", undefined, 20)).toBe(20);
  const led: LedgerRow[] = [
    { project: "a", branch: "x", offset: 20 },
    { project: "b", branch: "y", offset: 60 },
  ];
  expect(allocateOffset(led, "c", "z", undefined, 20)).toBe(40);
  // a known branch keeps its recorded offset whatever the step
  expect(allocateOffset([{ project: "a", branch: "old", offset: 10 }], "a", "old", undefined, 20)).toBe(10);
});
