import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { portSwap, upsertEnvLine, setSettingsPort, applyLinks } from "../src/links";
import { ovrFilePath, envFilePath } from "../src/paths";

// wt.config.ts declaring the mesh links applyLinks reads via resolveLinkSpecs.
// Imports defineWorkspace by absolute path so it loads from any temp orch dir.
const CONFIG_SRC = resolve(import.meta.dir, "../src/config");
const WT_CONFIG = `
import { defineWorkspace } from ${JSON.stringify(CONFIG_SRC)};
export default defineWorkspace({
  branches: { base: "develop", prefix: "feature/" },
  defaults: { plugin: "@wt/plugin-meteor" },
  projects: {
    "apartx-cabinet": {},
    "apartx-server": {},
  },
  links: [
    "apartx-cabinet:apartx-server:env:SERVER_URL",
    "apartx-cabinet:apartx-server:settings:public.serverUrl",
  ],
});
`;

test("portSwap: host:port/path and bare end", () => {
  expect(portSwap("http://h:4000/api", 4510)).toBe("http://h:4510/api");
  expect(portSwap("http://h:4000", 4510)).toBe("http://h:4510");
  expect(portSwap("h:3500", 3710)).toBe("h:3710");
});

test("upsertEnvLine: empty / preserve other / replace same", () => {
  expect(upsertEnvLine("", "SERVER_URL", "http://h:4510")).toBe("SERVER_URL=http://h:4510\n");
  expect(upsertEnvLine("OTHER=1\n", "SERVER_URL", "u")).toBe("OTHER=1\nSERVER_URL=u\n");
  expect(upsertEnvLine("SERVER_URL=old\nOTHER=1\n", "SERVER_URL", "new")).toBe("OTHER=1\nSERVER_URL=new\n");
});

test("setSettingsPort: nested replace + missing throws", () => {
  const j = { public: { serverUrl: "http://h:4000/" } };
  expect(setSettingsPort(j, "public.serverUrl", 4510)).toEqual({ public: { serverUrl: "http://h:4510/" } });
  expect(() => setSettingsPort({ public: {} }, "public.serverUrl", 1)).toThrow(/нет/);
});

function meshOrch(): string {
  const orch = mkdtempSync(resolve(tmpdir(), "wt-link-"));
  // consumer base .env (env-link source)
  mkdirSync(resolve(orch, "projects", "apartx-cabinet"), { recursive: true });
  writeFileSync(resolve(orch, "projects", "apartx-cabinet", ".env"), "SERVER_URL=http://dev:4000\n");
  // consumer worktree settings.json (settings-link source)
  mkdirSync(resolve(orch, "worktrees", "apartx-cabinet", "x"), { recursive: true });
  writeFileSync(resolve(orch, "worktrees", "apartx-cabinet", "x", "settings.json"), JSON.stringify({ public: { serverUrl: "http://dev:4000/" } }));
  // target worktree .env.worktree with PORT (target_port source)
  mkdirSync(resolve(orch, "worktrees", "apartx-server", "x"), { recursive: true });
  writeFileSync(resolve(orch, "worktrees", "apartx-server", "x", ".env.worktree"), "PORT=4510\n");
  // config declaring the link specs applyLinks resolves
  writeFileSync(resolve(orch, "wt.config.ts"), WT_CONFIG);
  return orch;
}

test("applyLinks: cabinet→server writes env layer + settings override (port-swapped)", async () => {
  const orch = meshOrch();
  try {
    const out = await applyLinks(orch, "apartx-cabinet", "x", "x");
    // cabinet has env:SERVER_URL and settings:public.serverUrl upstreams to server
    expect(out.filter((o) => o.status === "written")).toHaveLength(2);
    expect(readFileSync(envFilePath(orch, "apartx-cabinet", "x"), "utf8")).toBe("SERVER_URL=http://dev:4510\n");
    expect(JSON.parse(readFileSync(ovrFilePath(orch, "apartx-cabinet", "x"), "utf8"))).toEqual({ public: { serverUrl: "http://dev:4510/" } });
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("applyLinks: skip-no-port when target worktree absent", async () => {
  const orch = meshOrch();
  try {
    rmSync(resolve(orch, "worktrees", "apartx-server", "x"), { recursive: true, force: true });
    const out = await applyLinks(orch, "apartx-cabinet", "x", "x");
    expect(out.every((o) => o.status === "skip-no-port")).toBe(true);
    expect(existsSync(envFilePath(orch, "apartx-cabinet", "x"))).toBe(false);
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});
