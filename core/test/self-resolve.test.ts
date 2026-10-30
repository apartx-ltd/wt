import { test, expect, beforeAll, afterAll } from "bun:test";
import { resolve } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config";
import { registerSelfResolver } from "../src/self-resolve";

// A consumer workspace outside the package, with no node_modules: the real-world shape of
// a globally installed wt loading the user's wt.config.ts. Imports go through files in this
// dir — from inside the package Bun's own self-reference would resolve `@apartx/wt` anyway.
let workspace: string;

beforeAll(() => {
  workspace = mkdtempSync(resolve(tmpdir(), "wt-self-resolve-"));
  writeFileSync(
    resolve(workspace, "wt.config.ts"),
    `import { defineWorkspace } from "@apartx/wt";\n` +
      `export default defineWorkspace({ projectsDir: "projects", defaults: { plugin: "@apartx/wt/plugin-node" }, projects: { app: {} } });\n`,
  );
  writeFileSync(resolve(workspace, "meteor.ts"), `export { meteorPlugin } from "@apartx/wt/plugin-meteor";\n`);
  writeFileSync(resolve(workspace, "unknown.ts"), `export * from "@apartx/wt/no-such-export";\n`);
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

test("loadConfig resolves `@apartx/wt` in a consumer wt.config.ts without node_modules", async () => {
  expect(existsSync(resolve(workspace, "node_modules"))).toBe(false);
  const cfg = await loadConfig(workspace, "x");
  expect(cfg.projects.app.plugin).toBe("@apartx/wt/plugin-node");
});

test("registerSelfResolver maps `@apartx/wt/plugin-meteor` to the package's meteor plugin", async () => {
  registerSelfResolver();
  expect(() => registerSelfResolver()).not.toThrow(); // idempotent: a repeat call is a no-op
  const mod = await import(resolve(workspace, "meteor.ts"));
  expect(mod.meteorPlugin).toBeDefined();
  expect(mod.meteorPlugin).toBe((await import("../../plugins/meteor/src/index")).meteorPlugin);
});

test("`@apartx/wt/config-schema` resolves like a native JSON import (default + named keys)", async () => {
  registerSelfResolver();
  writeFileSync(
    resolve(workspace, "schema.ts"),
    `export { default, $schema } from "@apartx/wt/config-schema";\n`,
  );
  const mod = await import(resolve(workspace, "schema.ts"));
  expect(mod.default.$schema).toBeString();
  expect(mod.$schema).toBe(mod.default.$schema);
});

test("the self-resolver wins over an `@apartx/wt` in the consumer's node_modules", async () => {
  const consumer = mkdtempSync(resolve(tmpdir(), "wt-self-resolve-nm-"));
  try {
    const fake = resolve(consumer, "node_modules/@apartx/wt");
    mkdirSync(fake, { recursive: true });
    writeFileSync(resolve(fake, "package.json"), JSON.stringify({ name: "@apartx/wt", type: "module", exports: { ".": "./index.ts" } }));
    writeFileSync(resolve(fake, "index.ts"), `export const defineWorkspace = () => "FAKE";\n`);
    writeFileSync(
      resolve(consumer, "wt.config.ts"),
      `import { defineWorkspace } from "@apartx/wt";\n` +
        `export default defineWorkspace({ projectsDir: "projects", defaults: { plugin: "@apartx/wt/plugin-node" }, projects: { app: {} } });\n`,
    );
    const cfg = await loadConfig(consumer, "x");
    expect(cfg.projects.app.plugin).toBe("@apartx/wt/plugin-node");
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});

test("an unknown `@apartx/wt/…` subpath fails to resolve", async () => {
  registerSelfResolver();
  await expect(import(resolve(workspace, "unknown.ts"))).rejects.toThrow(/Cannot find module '@apartx\/wt\/no-such-export'/);
});
