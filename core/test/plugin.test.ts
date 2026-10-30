import { test, expect } from "bun:test";
import type { StackPlugin, InstanceCtx } from "../src/plugin";
import { registerPlugin, loadPlugin, PLUGIN_API_VERSION } from "../src/plugin";

test("a StackPlugin object satisfies the interface and returns a Command from devCommand", () => {
  const fake: StackPlugin = {
    name: "fake",
    install: () => ({ argv: ["npm", "install"] }),
    devCommand: (ctx: InstanceCtx) => ({ argv: ["serve", "--port", String(ctx.port)] }),
    extraPorts: [{ name: "hmr", basePort: 8085, envKey: "RSPACK_DEVSERVER_PORT" }],
  };
  const ctx = {
    orch: "/o", project: "p", slug: "s", branch: "feature/s",
    projectDir: "/o/projects/p", worktreeDir: "/o/worktrees/p/s",
    config: { plugin: "fake" },
    port: 4010, offset: 10, container: "wtdev-p-s", mode: "docker", extraPorts: { hmr: 8095 },
  } as InstanceCtx;
  expect(fake.devCommand(ctx).argv).toEqual(["serve", "--port", "4010"]);
  expect(fake.name).toBe("fake");
  expect(fake.extraPorts?.[0]?.name).toBe("hmr");
  expect(fake.extraPorts?.[0]?.basePort).toBe(8085);
});

test("loadPlugin returns a registered plugin by name", async () => {
  const p: StackPlugin = { name: "demo", apiVersion: PLUGIN_API_VERSION, install: () => ({ argv: ["i"] }), devCommand: () => ({ argv: ["d"] }) };
  registerPlugin("@wt/plugin-demo", p);
  expect(await loadPlugin("@wt/plugin-demo")).toBe(p);
});

test("loadPlugin throws a clear error for an unknown plugin", async () => {
  await expect(loadPlugin("@wt/plugin-nope")).rejects.toThrow(/неизвестный плагин: @wt\/plugin-nope/);
});

const base: StackPlugin = {
  name: "fake",
  apiVersion: PLUGIN_API_VERSION,
  install: () => ({ argv: ["x"] }),
  devCommand: () => ({ argv: ["x"] }),
};

test("loadPlugin accepts a current-apiVersion plugin", async () => {
  registerPlugin("@fake/ok", { ...base });
  expect(await loadPlugin("@fake/ok")).toMatchObject({ name: "fake" });
});

test("loadPlugin rejects a plugin without apiVersion", async () => {
  const { apiVersion, ...noVersion } = base;
  registerPlugin("@fake/none", noVersion as StackPlugin);
  await expect(loadPlugin("@fake/none")).rejects.toThrow(/apiVersion|совместим/i);
});

test("loadPlugin rejects an incompatible apiVersion", async () => {
  registerPlugin("@fake/old", { ...base, apiVersion: PLUGIN_API_VERSION + 1 });
  await expect(loadPlugin("@fake/old")).rejects.toThrow(/apiVersion|совместим/i);
});
