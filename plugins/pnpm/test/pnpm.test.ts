import { test, expect } from "bun:test";
import { pnpmPlugin } from "../src/index";
import { PLUGIN_API_VERSION, loadPlugin } from "#core/plugin";
import { registerBundledPlugins } from "#plugins";

test("pnpm plugin: current apiVersion, inline injection", () => {
  expect(pnpmPlugin.apiVersion).toBe(PLUGIN_API_VERSION);
  expect(pnpmPlugin.envInjection).toBe("inline");
});

test("pnpm plugin: frozen install, pnpm dev without --port", () => {
  expect(pnpmPlugin.install({} as any).argv).toEqual(["pnpm", "install", "--frozen-lockfile"]);
  expect(pnpmPlugin.devCommand({ port: 4110 } as any).argv).toEqual(["pnpm", "dev"]);
});

test("pnpm plugin: deps fingerprint is package.json + pnpm-lock.yaml", () => {
  expect(pnpmPlugin.deps).toEqual({ dir: "node_modules", files: ["package.json", "pnpm-lock.yaml"] });
  expect(pnpmPlugin.artifactDirs).toEqual(["node_modules"]);
});

test("pnpm plugin: no extra ports, no isolated-db, no docker", () => {
  expect(pnpmPlugin.extraPorts).toBeUndefined();
  expect(pnpmPlugin.isolatedDb).toBeUndefined();
  expect(pnpmPlugin.docker).toBeUndefined();
});

test("registry knows @apartx/wt/plugin-pnpm", async () => {
  registerBundledPlugins();
  expect((await loadPlugin("@apartx/wt/plugin-pnpm")).name).toBe("pnpm");
});
