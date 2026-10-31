import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { rustPlugin } from "../src/index";
import { PLUGIN_API_VERSION } from "#core/plugin";

let wt: string;
beforeEach(() => {
  wt = mkdtempSync(resolve(tmpdir(), "wt-rust-"));
  writeFileSync(resolve(wt, "Cargo.toml"), `[package]\nname = "api"\n`);
});
afterEach(() => rmSync(wt, { recursive: true, force: true }));

const ctx = (over: Record<string, unknown> = {}) =>
  ({ worktreeDir: wt, container: "wtdev-api-slug", port: 8090, mode: "host", ...over }) as any;

test("rust plugin declares the current apiVersion and inline env injection", () => {
  expect(rustPlugin.apiVersion).toBe(PLUGIN_API_VERSION);
  expect(rustPlugin.envInjection).toBe("inline");
});

test("rust plugin: install is cargo fetch; deps are Cargo.toml/Cargo.lock restored into target/", () => {
  expect(rustPlugin.install(ctx()).argv).toEqual(["cargo", "fetch"]);
  expect(rustPlugin.deps).toEqual({ dir: "target", files: ["Cargo.toml", "Cargo.lock"] });
  expect(rustPlugin.artifactDirs).toEqual(["target"]);
});

test("rust plugin devCommand: cargo run, the port reaches the binary only through $PORT (no --port flag)", () => {
  const argv = rustPlugin.devCommand(ctx()).argv;
  expect(argv).toEqual(["cargo", "run"]);
  expect(argv.join(" ")).not.toContain("8090");
  expect(rustPlugin.devCommand(ctx({ mode: "docker" })).argv).toEqual(["cargo", "run"]);
});

test("rust plugin devCommand: a `dev` cargo alias in .cargo/config.toml is preferred over cargo run", () => {
  mkdirSync(resolve(wt, ".cargo"));
  writeFileSync(resolve(wt, ".cargo", "config.toml"), `[build]\njobs = 4\n\n[alias]\ndev = "run --features dev"\n`);
  expect(rustPlugin.devCommand(ctx()).argv).toEqual(["cargo", "dev"]);
});

test("rust plugin devCommand: the alias is also read from the extension-less .cargo/config", () => {
  mkdirSync(resolve(wt, ".cargo"));
  writeFileSync(resolve(wt, ".cargo", "config"), `[alias]\ndev = ["run", "--bin", "api"]\n`);
  expect(rustPlugin.devCommand(ctx()).argv).toEqual(["cargo", "dev"]);
});

test("rust plugin devCommand: a `dev` key outside [alias] does not count", () => {
  mkdirSync(resolve(wt, ".cargo"));
  writeFileSync(resolve(wt, ".cargo", "config.toml"), `[env]\ndev = "1"\n\n[alias]\nb = "build"\n`);
  expect(rustPlugin.devCommand(ctx()).argv).toEqual(["cargo", "run"]);
});

test("rust plugin: no isolated-db, no extra ports", () => {
  expect(rustPlugin.isolatedDb).toBeUndefined();
  expect(rustPlugin.extraPorts).toBeUndefined();
});

test("rust plugin docker: repo + target volume per worktree, shared cargo registry/git caches", () => {
  const spec = rustPlugin.docker!(ctx({ worktreeDir: "/wt/api" }));
  expect(spec.mounts).toEqual([
    "/wt/api:/opt/app",
    "wtdev-api-slug-target:/opt/app/target",
    "cargo_registry:/usr/local/cargo/registry",
    "cargo_git:/usr/local/cargo/git",
  ]);
  expect(spec.ownedVolumes).toEqual(["wtdev-api-slug-target"]);
  expect(spec.addHosts).toEqual(["host.docker.internal:host-gateway"]);
});

test("rust plugin: a startup budget of 30 minutes covers a cold cargo build; node and meteor keep the core default", async () => {
  expect(rustPlugin.upTimeoutMs).toBe(30 * 60_000);
  const { nodePlugin } = await import("#plugin-node");
  const { meteorPlugin } = await import("#plugin-meteor");
  expect(nodePlugin.upTimeoutMs).toBeUndefined();
  expect(meteorPlugin.upTimeoutMs).toBeUndefined();
});
