import { test, expect, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { webBuildDir } from "#core";
import { tuiSpawnArgv, runWeb } from "../src/dashboards";

test("tuiSpawnArgv: bun + explicit absolute preload + the TUI entry under the package root", () => {
  const argv = tuiSpawnArgv("/x");
  expect(argv).toHaveLength(4);
  expect(argv[0]).toBe(process.execPath);
  expect(argv[1]).toBe("--preload");
  expect(argv[2]!.startsWith("/")).toBe(true);
  expect(argv[2]!.endsWith("/scripts/preload.js")).toBe(true);
  expect(argv[3]).toBe("/x/tui/bin/wt-ui.tsx");
});

test("webBuildDir resolves web/build under the package root", () => {
  expect(webBuildDir("/x")).toBe("/x/web/build");
});

test("runWeb without a built dashboard exits 1 with the build hint on stderr", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "wt-web-nobuild-"));
  const writes: string[] = [];
  const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  try {
    expect(await runWeb({ dev: false, root })).toBe(1);
  } finally {
    spy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
  expect(writes.join("")).toContain(
    "wt web: dashboard is not built — run `bun run build:web` in the wt checkout, or use `wt web --dev`",
  );
});

test("runWeb --dev without a web/ source checkout exits 1 with the hint, before starting a daemon", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "wt-web-nosrc-"));
  mkdirSync(resolve(root, "web/build"), { recursive: true });
  writeFileSync(resolve(root, "web/build/index.html"), "<!doctype html>");
  const writes: string[] = [];
  let ensureCalls = 0;
  const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  try {
    const code = await runWeb(
      { dev: true, root, orch: root },
      { ensureServer: async () => { ensureCalls++; return { baseUrl: "http://localhost:0", replaced: false }; } },
    );
    expect(code).toBe(1);
  } finally {
    spy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
  expect(ensureCalls).toBe(0);
  expect(writes.join("")).toContain(
    "wt web --dev: needs a wt source checkout (web/ is not shipped in the npm package) — clone github.com/apartx-ltd/wt and run it from there",
  );
});
