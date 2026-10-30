import { test, expect } from "bun:test";
import { nodePlugin } from "../src/index";
import { PLUGIN_API_VERSION } from "#core/plugin";

test("node plugin declares the current apiVersion", () => {
  expect(nodePlugin.apiVersion).toBe(PLUGIN_API_VERSION);
});

test("node plugin: inline injection, npm install, npm run dev -- --port", () => {
  expect(nodePlugin.envInjection).toBe("inline");
  expect(nodePlugin.install({} as any).argv).toEqual(["npm", "install"]);
  expect(nodePlugin.devCommand({ port: 5173 } as any).argv).toEqual(["npm", "run", "dev", "--", "--port", "5173"]);
});

test("node plugin: no isolated-db, no extra ports", () => {
  expect(nodePlugin.isolatedDb).toBeUndefined();
  expect(nodePlugin.extraPorts).toBeUndefined();
});

test("node plugin docker: repo + node_modules volume, no meteor volumes", () => {
  const spec = nodePlugin.docker!({ worktreeDir: "/wt/app", container: "wtdev-app-slug" } as any);
  expect(spec.mounts).toEqual([
    "/wt/app:/opt/app",
    "wtdev-app-slug-node_modules:/opt/app/node_modules",
  ]);
  expect(spec.ownedVolumes).toEqual(["wtdev-app-slug-node_modules"]);
  expect(spec.mounts.some((m) => m.includes("meteor"))).toBe(false);
});

test("node plugin docker: the Mongo URL gets directConnection (the dev Mongo is a replica set)", () => {
  const { envLineFilter } = nodePlugin.docker!({ worktreeDir: "/wt/app", container: "c" } as any);
  expect(envLineFilter!("MONGO_URL=mongodb://devhost:27017/apartx")).toBe(
    "MONGO_URL=mongodb://devhost:27017/apartx?directConnection=true",
  );
  expect(envLineFilter!("PUBLIC_ROOT_CATEGORY_ID=abc")).toBe("PUBLIC_ROOT_CATEGORY_ID=abc");
});

test("node plugin devCommand: no --host — that is the project's concern, not the stack's", () => {
  const argv = nodePlugin.devCommand({ port: 5173, mode: "docker" } as any).argv;
  expect(argv).not.toContain("--host");
});

test("node plugin: restorable directory for wt slim — node_modules", () => {
  expect(nodePlugin.artifactDirs).toEqual(["node_modules"]);
});
