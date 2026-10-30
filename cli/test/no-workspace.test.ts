import { test, expect } from "bun:test";
import { resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const bin = resolve(import.meta.dir, "..", "bin", "wt.ts");

async function wtIn(cwd: string, ...args: string[]) {
  const env = { ...process.env };
  delete env.WT_ORCH;
  const proc = Bun.spawn([process.execPath, bin, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

test("wt list outside any workspace exits 1 with a one-line error and no stack trace", async () => {
  const { stderr, code } = await wtIn(tmpdir(), "list");
  expect(code).toBe(1);
  const lines = stderr.trimEnd().split("\n");
  expect(lines).toHaveLength(1);
  expect(lines[0]!.startsWith("wt: no wt.config.ts found")).toBe(true);
  // no stack frames (`    at fn (file:line)`); the message itself says "at the workspace root"
  expect(stderr).not.toMatch(/^\s+at /m);
});

for (const args of [["help"], ["--version"], []]) {
  test(`wt ${args.join(" ") || "(no command)"} works outside any workspace`, async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "wt-no-ws-"));
    try {
      const { stdout, stderr, code } = await wtIn(dir, ...args);
      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(stdout.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
