import { test, expect } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");
const { version } = require("../../package.json");

async function wt(...args: string[]): Promise<string> {
  const proc = Bun.spawn([process.execPath, "cli/bin/wt.ts", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout;
}

test("wt --version prints the package version", async () => {
  expect((await wt("--version")).trim()).toBe(version);
});

test("wt version prints the package version", async () => {
  expect((await wt("version")).trim()).toBe(version);
});
