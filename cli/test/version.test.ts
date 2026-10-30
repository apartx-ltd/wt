import { test, expect } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");
const { version } = require("../../package.json");

async function wt(...args: string[]) {
  const proc = Bun.spawn([process.execPath, "cli/bin/wt.ts", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

for (const arg of ["--version", "version"]) {
  test(`wt ${arg} prints the package version and exits 0`, async () => {
    const { stdout, stderr, code } = await wt(arg);
    expect(stdout.trim()).toBe(version);
    expect(stderr).toBe("");
    expect(code).toBe(0);
  });
}
