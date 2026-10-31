import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createWorktree } from "../src/new-worktree";
import { startInstance, upTimeoutMs, DEFAULT_UP_TIMEOUT_MS } from "../src/start";
import { stopInstance } from "../src/run";

// How long `wt start` waits for the instance port after spawning the dev command: the
// plugin's `upTimeoutMs` when set, otherwise the core's former fixed 10 minutes.

const CONFIG_SRC = resolve(import.meta.dir, "../src/config");
const PLUGIN_SRC = resolve(import.meta.dir, "../src/plugin");

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

/**
 * A workspace with one host project `api` (real git repo, base PORT in .env) and an inline
 * plugin whose dev command is `devArgv`, with the extra plugin fields `pluginFields`.
 * The base port is random so parallel test files do not collide on the worktree port.
 */
async function makeOrch(devArgv: string[], pluginFields: string): Promise<string> {
  const orch = mkdtempSync(resolve(tmpdir(), "wt-start-wait-"));
  const pdir = resolve(orch, "projects", "api");
  mkdirSync(pdir, { recursive: true });
  writeFileSync(resolve(pdir, ".env"), `PORT=${20000 + Math.floor(Math.random() * 2000) * 10}\n`);
  writeFileSync(
    resolve(orch, "wt.config.ts"),
    `
import { defineWorkspace } from ${JSON.stringify(CONFIG_SRC)};
import { registerPlugin, PLUGIN_API_VERSION } from ${JSON.stringify(PLUGIN_SRC)};
registerPlugin("@apartx/wt/plugin-slow", {
  name: "slow",
  apiVersion: PLUGIN_API_VERSION,
  install: () => ({ argv: ["true"] }),
  devCommand: () => ({ argv: ${JSON.stringify(devArgv)} }),
  ${pluginFields}
});
export default defineWorkspace({
  defaults: { plugin: "@apartx/wt/plugin-slow" },
  projects: { api: {} },
});
`,
  );
  await git(pdir, "init", "-q", "-b", "main");
  await git(pdir, "config", "user.email", "t@t.t");
  await git(pdir, "config", "user.name", "t");
  await git(pdir, "add", "-A");
  await git(pdir, "commit", "-q", "-m", "init");
  return orch;
}

test("upTimeoutMs: the plugin's value when set, the former fixed 10 minutes otherwise", () => {
  expect(DEFAULT_UP_TIMEOUT_MS).toBe(600_000);
  expect(upTimeoutMs({})).toBe(600_000);
  expect(upTimeoutMs({ upTimeoutMs: 1_800_000 })).toBe(1_800_000);
});

test("startInstance gives up on the port after the plugin's upTimeoutMs, not after the fixed wait", async () => {
  // The dev command never listens; without the plugin budget the core would wait 10 minutes
  // (or until the process dies), so the elapsed time is the assertion.
  const orch = await makeOrch(["sleep", "120"], "upTimeoutMs: 1000,");
  try {
    await createWorktree(orch, "api", "feat");
    const t0 = Date.now();
    const r = await startInstance(orch, "api", "feat");
    const elapsed = Date.now() - t0;
    expect(r.portUp).toBe(false);
    expect(r.pid).not.toBeNull();
    expect(elapsed).toBeLessThan(10_000);
  } finally {
    await stopInstance(orch, "api", "feat");
    rmSync(orch, { recursive: true, force: true });
  }
}, 30_000);

test("startInstance without a plugin budget still waits for a server that comes up after a few seconds", async () => {
  const orch = await makeOrch(["bun", "serve.ts"], "");
  writeFileSync(
    resolve(orch, "projects", "api", "serve.ts"),
    `await Bun.sleep(6000);\nBun.serve({ port: Number(process.env.PORT), fetch: () => new Response("ok") });\n`,
  );
  await git(resolve(orch, "projects", "api"), "add", "-A");
  await git(resolve(orch, "projects", "api"), "commit", "-q", "-m", "serve");
  try {
    await createWorktree(orch, "api", "feat");
    const r = await startInstance(orch, "api", "feat");
    expect(r.portUp).toBe(true);
  } finally {
    await stopInstance(orch, "api", "feat");
    rmSync(orch, { recursive: true, force: true });
  }
}, 40_000);
