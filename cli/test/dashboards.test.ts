import { test, expect, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { tuiSpawnArgv, webBuildDir, runWeb } from "../src/dashboards";

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
