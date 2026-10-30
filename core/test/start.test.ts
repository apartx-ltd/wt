import { test, expect, describe, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { baseCheckoutDockerEnv, buildDockerRunArgs, devHost, buildHostDevArgs, buildHostMeteorArgs, remapEnvLine, remapSettingsHosts, renderEnvFile, shInherit, spawnDetached, type StartOptions } from "../src/start";
import { BASE_SLUG } from "../src/new-worktree";
import type { StackPlugin } from "../src/plugin";
import type { ResolvedProjectConfig } from "../src/config";
import { readFile } from "node:fs/promises";

// Mounts/addHosts/innerCmd/image now come from the plugin (meteor) — the core only assembles
// the argv. Here we reproduce the same set the legacy inline block produced, so that the argv
// stays byte-for-byte identical (the only allowed delta is a single space in the inner cmd
// without --settings: legacy `meteor run  --port` → plugin `meteor run --port`).
const container = "wtdev-apartx-server-feat";
const meteorMounts = [
  "/orch/worktrees/apartx-server/feat:/opt/app",
  `${container}-node_modules:/opt/app/node_modules`,
  `${container}-meteor_local:/opt/app/.meteor/local`,
  "meteor_base:/root",
];
const base = {
  container,
  port: 4010,
  extraPorts: { hmr: 8085 },
  envFile: "/orch/var/run/apartx-server-feat.env.merged",
  mounts: meteorMounts,
  addHosts: ["host.docker.internal:host-gateway"],
  innerCmd: "meteor run --port 4010",
  image: "meteor-dev:3.4",
  dockerEnv: { METEOR_WATCH_FORCE_POLLING: "true", METEOR_WATCH_POLLING_INTERVAL_MS: "500" },
};

test("buildDockerRunArgs: core shape (no dev-host, no settings)", () => {
  expect(buildDockerRunArgs(base)).toEqual([
    "run", "-d", "--name", "wtdev-apartx-server-feat",
    "--add-host", "host.docker.internal:host-gateway",
    "-e", "METEOR_WATCH_FORCE_POLLING=true",
    "-e", "METEOR_WATCH_POLLING_INTERVAL_MS=500",
    "-e", "NODE_OPTIONS=--dns-result-order=ipv4first",
    "-p", "4010:4010",
    "-p", "8085:8085",
    "--env-file", "/orch/var/run/apartx-server-feat.env.merged",
    "-v", "/orch/worktrees/apartx-server/feat:/opt/app",
    "-v", "wtdev-apartx-server-feat-node_modules:/opt/app/node_modules",
    "-v", "wtdev-apartx-server-feat-meteor_local:/opt/app/.meteor/local",
    "-v", "meteor_base:/root",
    "-w", "/opt/app",
    "meteor-dev:3.4",
    "sh", "-c", "meteor run --port 4010",
  ]);
});

test("buildDockerRunArgs: with dev-host adds second --add-host", () => {
  // The core concatenates the plugin's addHosts with the dynamic dev host (order preserved).
  const args = buildDockerRunArgs({ ...base, addHosts: [...base.addHosts, "boomfly-m2.local:host-gateway"] });
  const i = args.indexOf("boomfly-m2.local:host-gateway");
  expect(i).toBeGreaterThan(0);
  expect(args[i - 1]).toBe("--add-host");
});

test("buildDockerRunArgs: custom hmr extra-port maps second port", () => {
  const args = buildDockerRunArgs({ ...base, extraPorts: { hmr: 8115 } });
  expect(args).toContain("8115:8115");
});

test("buildDockerRunArgs: with settings adds mount + --settings flag", () => {
  const args = buildDockerRunArgs({
    ...base,
    innerCmd: "meteor run --settings .wt-settings.json --port 4010",
    settingsMount: "/orch/var/run/apartx-server-feat.settings.docker.json",
  });
  expect(args).toContain("/orch/var/run/apartx-server-feat.settings.docker.json:/opt/app/.wt-settings.json:ro");
  expect(args[args.length - 1]).toBe("meteor run --settings .wt-settings.json --port 4010");
});

describe("buildDockerRunArgs dockerEnv", () => {
  const base = {
    container: "wtdev-p-base", port: 3000, envFile: "/e", mounts: ["/m:/m"],
    addHosts: [], innerCmd: "run", image: "img:1",
  };

  it("emits plugin env -e flags in insertion order BEFORE generic NODE_OPTIONS", () => {
    const args = buildDockerRunArgs({
      ...base,
      dockerEnv: { METEOR_WATCH_FORCE_POLLING: "true", METEOR_WATCH_POLLING_INTERVAL_MS: "500" },
    });
    const i = (s: string) => args.indexOf(s);
    expect(i("METEOR_WATCH_FORCE_POLLING=true")).toBeGreaterThan(-1);
    expect(i("METEOR_WATCH_POLLING_INTERVAL_MS=500")).toBeLessThan(i("NODE_OPTIONS=--dns-result-order=ipv4first"));
    expect(i("METEOR_WATCH_FORCE_POLLING=true")).toBeLessThan(i("METEOR_WATCH_POLLING_INTERVAL_MS=500"));
  });

  it("with no dockerEnv emits only the generic NODE_OPTIONS", () => {
    const args = buildDockerRunArgs(base);
    expect(args.filter((a) => a === "-e")).toHaveLength(1); // only NODE_OPTIONS
    expect(args).toContain("NODE_OPTIONS=--dns-result-order=ipv4first");
    expect(args.some((a) => a.startsWith("METEOR_WATCH"))).toBe(false);
  });
});

describe("baseCheckoutDockerEnv: base checkouts gain plugin HMR env as -e", () => {
  const hmrLines = ["RSPACK_DEVSERVER_PORT=8085", "HMR_PUBLIC_PORT=8085"];

  it("merges plugin envLines into dockerEnv for the BASE slug", () => {
    const env = baseCheckoutDockerEnv(BASE_SLUG, { METEOR_WATCH_FORCE_POLLING: "true" }, hmrLines);
    expect(env).toEqual({
      METEOR_WATCH_FORCE_POLLING: "true",
      RSPACK_DEVSERVER_PORT: "8085",
      HMR_PUBLIC_PORT: "8085",
    });
    // and they surface as `-e KEY=VALUE` in the docker argv
    const args = buildDockerRunArgs({
      container: "wtdev-apartx-server-base", port: 4000, envFile: "/e", mounts: ["/m:/m"],
      addHosts: [], innerCmd: "run", image: "img:1", dockerEnv: env,
    });
    expect(args).toContain("RSPACK_DEVSERVER_PORT=8085");
    expect(args).toContain("HMR_PUBLIC_PORT=8085");
  });

  it("does NOT inject plugin envLines for a worktree slug (carried via --env-file)", () => {
    const env = baseCheckoutDockerEnv("feat", { METEOR_WATCH_FORCE_POLLING: "true" }, hmrLines);
    expect(env).toEqual({ METEOR_WATCH_FORCE_POLLING: "true" });
    const args = buildDockerRunArgs({
      container: "wtdev-apartx-server-feat", port: 4010, envFile: "/e", mounts: ["/m:/m"],
      addHosts: [], innerCmd: "run", image: "img:1", dockerEnv: env,
    });
    expect(args.some((a) => a.startsWith("RSPACK_DEVSERVER_PORT="))).toBe(false);
    expect(args.some((a) => a.startsWith("HMR_PUBLIC_PORT="))).toBe(false);
  });

  it("handles a base with no plugin env (returns the spec env unchanged)", () => {
    expect(baseCheckoutDockerEnv(BASE_SLUG, undefined, [])).toEqual({});
  });
});

test("buildHostMeteorArgs: base only (main slug, no overlay/settings)", () => {
  expect(buildHostMeteorArgs({ baseEnv: "/o/projects/apartx-apple/.env", hasWorktreeEnv: false, innerCmd: "meteor run --port $PORT" })).toEqual([
    "npx", "dotenvx", "run", "-f", "/o/projects/apartx-apple/.env", "--", "sh", "-c", "meteor run --port $PORT",
  ]);
});

test("buildHostMeteorArgs: worktree + overlay + settings (dotenvx left-wins order)", () => {
  expect(
    buildHostMeteorArgs({
      baseEnv: "/o/projects/apartx-cabinet/.env",
      hasWorktreeEnv: true,
      envOverlay: "/o/var/env/apartx-cabinet-x.env",
      innerCmd: "meteor run --settings=settings/settings.json --port $PORT",
    }),
  ).toEqual([
    "npx", "dotenvx", "run",
    "-f", "/o/var/env/apartx-cabinet-x.env",
    "-f", ".env.worktree",
    "-f", "/o/projects/apartx-cabinet/.env",
    "--", "sh", "-c", "meteor run --settings=settings/settings.json --port $PORT",
  ]);
});

it("StartOptions.link accepts an arbitrary target name (no apartx literal in core)", () => {
  const opts: StartOptions = { link: "some-upstream" };
  expect(opts.link).toBe("some-upstream"); // compiles ⇒ type is "all" | string, not "all" | "apartx-server"
});

test("remapEnvLine: localhost→host except ROOT_URL", () => {
  expect(remapEnvLine("NATS_SERVERS=nats://localhost:4222", "dev.local")).toBe("NATS_SERVERS=nats://dev.local:4222");
  expect(remapEnvLine("ROOT_URL=http://localhost:3701", "dev.local")).toBe("ROOT_URL=http://localhost:3701");
  expect(remapEnvLine("X=http://127.0.0.1:9", "dev.local")).toBe("X=http://dev.local:9");
});

it("remapEnvLine no longer injects mongo directConnection on its own", () => {
  expect(remapEnvLine("MONGO_URL=mongodb://localhost/db", "h"))
    .toBe("MONGO_URL=mongodb://h/db"); // host remapped, NO directConnection
});

it("remapEnvLine applies the plugin filter after the generic remap", () => {
  const filter = (l: string) =>
    /^MONGO(_OPLOG)?_URL=mongodb/.test(l) && !l.includes("directConnection=")
      ? l + (l.includes("?") ? "&" : "?") + "directConnection=true"
      : l;
  expect(remapEnvLine("MONGO_URL=mongodb://localhost/db", "h", filter))
    .toBe("MONGO_URL=mongodb://h/db?directConnection=true");
  expect(remapEnvLine("ROOT_URL=http://localhost:3000", "h", filter))
    .toBe("ROOT_URL=http://localhost:3000"); // ROOT_URL untouched by both
});

test("remapSettingsHosts: remaps non-public, leaves public subtree intact", () => {
  const s = { mongoUrl: "mongodb://localhost:27017", public: { serverUrl: "http://localhost:3000", nested: { a: "127.0.0.1:9" } } };
  expect(remapSettingsHosts(s, "dev.local")).toEqual({
    mongoUrl: "mongodb://dev.local:27017",
    public: { serverUrl: "http://localhost:3000", nested: { a: "127.0.0.1:9" } },
  });
});

test("inline plugin host args: sh -c <inner> with env layered from .env (no dotenvx)", async () => {
  const orch = mkdtempSync(resolve(tmpdir(), "wt-inline-host-"));
  try {
    const project = "myapp";
    const pdir = resolve(orch, "projects", project);
    mkdirSync(pdir, { recursive: true });
    // base .env contributes FOO; .env.worktree overlays PORT-derived value
    writeFileSync(resolve(pdir, ".env"), "FOO=bar\nSHARED=base\n");

    const inline: StackPlugin = {
      name: "fake-inline",
      envInjection: "inline",
      install: () => ({ argv: ["npm", "install"] }),
      devCommand: (ctx) => ({ argv: ["serve", "--port", String(ctx.port)] }),
    };
    const config = { plugin: "fake-inline" } as ResolvedProjectConfig;

    // base slug → no .env.worktree layered; only base .env
    const out = await buildHostDevArgs({
      orch, project, slug: "base", dir: pdir, branch: "main", port: 4010, plugin: inline, config,
    });
    expect(out.argv).toEqual(["sh", "-c", "serve --port 4010"]);
    expect(out.env?.FOO).toBe("bar");
    expect(out.env?.SHARED).toBe("base");
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("inline plugin host args: .env.worktree overlays base .env (later wins)", async () => {
  const orch = mkdtempSync(resolve(tmpdir(), "wt-inline-wtree-"));
  try {
    const project = "myapp";
    const pdir = resolve(orch, "projects", project);
    const wdir = resolve(orch, "worktrees", project, "feat");
    mkdirSync(pdir, { recursive: true });
    mkdirSync(wdir, { recursive: true });
    writeFileSync(resolve(pdir, ".env"), "FOO=bar\nSHARED=base\n");
    writeFileSync(resolve(wdir, ".env.worktree"), "SHARED=wtree\nPORT=4010\n");

    const inline: StackPlugin = {
      name: "fake-inline",
      envInjection: "inline",
      install: () => ({ argv: ["npm", "install"] }),
      devCommand: (ctx) => ({ argv: ["serve", "--port", String(ctx.port)] }),
    };
    const config = { plugin: "fake-inline" } as ResolvedProjectConfig;

    const out = await buildHostDevArgs({
      orch, project, slug: "feat", dir: wdir, branch: "feat/x", port: 4010, plugin: inline, config,
    });
    expect(out.argv).toEqual(["sh", "-c", "serve --port 4010"]);
    expect(out.env?.FOO).toBe("bar");       // from base .env
    expect(out.env?.SHARED).toBe("wtree");  // .env.worktree wins
    expect(out.env?.PORT).toBe("4010");
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("inline plugin host args: single-repo (projectsDir '.') reads .env from the orch root itself", async () => {
  const orch = mkdtempSync(resolve(tmpdir(), "wt-inline-single-"));
  try {
    const project = "myapp"; // single-repo: project name = repo basename, root IS the project
    // base .env lives at the orch ROOT (not projects/<p>/.env)
    writeFileSync(resolve(orch, ".env"), "FOO=bar\nSHARED=root\n");

    const inline: StackPlugin = {
      name: "fake-inline",
      envInjection: "inline",
      install: () => ({ argv: ["npm", "install"] }),
      devCommand: (ctx) => ({ argv: ["serve", "--port", String(ctx.port)] }),
    };
    const config = { plugin: "fake-inline" } as ResolvedProjectConfig;

    const out = await buildHostDevArgs({
      orch, project, slug: "base", dir: orch, branch: "main", port: 5210, plugin: inline, config, projectsDir: ".",
    });
    expect(out.argv).toEqual(["sh", "-c", "serve --port 5210"]);
    expect(out.env?.FOO).toBe("bar");
    expect(out.env?.SHARED).toBe("root");
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("dotenvx plugin host args: base checkout injects the resolved PORT ($PORT) even when base .env omits it", async () => {
  const orch = mkdtempSync(resolve(tmpdir(), "wt-dotenvx-base-"));
  try {
    const project = "myapp";
    const pdir = resolve(orch, "projects", project);
    mkdirSync(pdir, { recursive: true });
    // base .env has NO PORT (like apartx-spaces, which keeps it in package.json)
    writeFileSync(resolve(pdir, ".env"), "ROOT_URL=https://x\n");

    const meteorish: StackPlugin = {
      name: "fake-meteor",
      envInjection: "dotenvx",
      install: () => ({ argv: ["meteor", "npm", "install"] }),
      devCommand: () => ({ argv: ["meteor", "run", "--port", "$PORT"] }),
    };
    const config = { plugin: "fake-meteor" } as ResolvedProjectConfig;

    const out = await buildHostDevArgs({
      orch, project, slug: "base", dir: pdir, branch: "develop", port: 3901, plugin: meteorish, config,
    });
    expect(out.argv).toEqual(["npx", "dotenvx", "run", "-f", resolve(pdir, ".env"), "--", "sh", "-c", "meteor run --port $PORT"]);
    // Without this, $PORT would expand to empty → "the --port option needs a value".
    expect(out.env?.PORT).toBe("3901");
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("spawnDetached forwards env to the child", async () => {
  const d = mkdtempSync(resolve(tmpdir(), "wt-spawn-"));
  try {
    const log = resolve(d, "out.log");
    const pid = spawnDetached("sh", ["-c", "echo $WT_TEST"], d, log, { WT_TEST: "hi" });
    expect(pid).toBeGreaterThan(0);
    // give the child a moment, then read the log
    await Bun.sleep(300);
    expect((await readFile(log, "utf8")).trim()).toBe("hi");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("renderEnvFile keeps `export KEY=...` lines (shell-style .env, e.g. apartx-whatsapp)", async () => {
  // Exercises both export-aware seams: the key-allowlist scan AND the addLine fallback
  // re-scan of .env.worktree. Uses the worktree fallback path so it's deterministic
  // regardless of whether `npx dotenvx` resolves in the test's temp cwd.
  const orch = mkdtempSync(resolve(tmpdir(), "wt-render-export-"));
  try {
    const project = "apartx-whatsapp";
    const pdir = resolve(orch, "projects", project);
    const wdir = resolve(orch, "worktrees", project, "feat");
    mkdirSync(pdir, { recursive: true });
    mkdirSync(wdir, { recursive: true });
    writeFileSync(resolve(pdir, ".env"), "PORT=3002\n");
    // shell-style export lines (as in apartx-whatsapp) must survive into the merged file
    writeFileSync(resolve(wdir, ".env.worktree"), "export MONGO_URL=mongodb://localhost:27017/apartx\nexport AWS_BUCKET=b\n");

    const out = await renderEnvFile(orch, project, "feat", "host.docker.internal");
    const content = await Bun.file(out).text();
    // localhost remapped to the dev-host, key survives the allowlist + addLine
    expect(content).toContain("MONGO_URL=mongodb://host.docker.internal:27017/apartx\n");
    expect(content).toContain("AWS_BUCKET=b\n");
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("renderEnvFile emits the base .env keys even when dotenvx is unavailable", async () => {
  // A non-Meteor project (apartx-help) does not pull dotenvx into its dependencies, so `npx dotenvx`
  // goes to the registry and fails — and stderr is suppressed. Without the raw fallback to the base .env
  // the project's whole config was silently lost and the instance came up on scrape defaults alone.
  const orch = mkdtempSync(resolve(tmpdir(), "wt-render-nodotenvx-"));
  try {
    const project = "apartx-help";
    const pdir = resolve(orch, "projects", project);
    const wdir = resolve(orch, "worktrees", project, "feat");
    mkdirSync(pdir, { recursive: true });
    mkdirSync(wdir, { recursive: true });

    writeFileSync(resolve(pdir, ".env"), "PUBLIC_ROOT_CATEGORY_ID=abc123\nMONGO_URL=mongodb://localhost:27017/apartx\nPORT=5173\n");
    writeFileSync(resolve(wdir, ".env.worktree"), "PORT=6153\nROOT_URL=http://localhost:6153\n");

    const out = await renderEnvFile(orch, project, "feat", "host.docker.internal");
    const content = await Bun.file(out).text();
    // a key that is neither in .env.worktree nor among the scrape defaults
    expect(content).toContain("PUBLIC_ROOT_CATEGORY_ID=abc123\n");
    // the DB name from .env is not lost in favor of the scrape default `mongodb://<host>:27017`
    expect(content).toContain("MONGO_URL=mongodb://host.docker.internal:27017/apartx\n");
    // the worktree still overrides the base port
    expect(content).toContain("PORT=6153\n");
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("renderEnvFile layers worktree-only keys over base .env", async () => {
  const orch = mkdtempSync(resolve(tmpdir(), "wt-render-env-"));
  try {
    const project = "apartx-admin";
    const pdir = resolve(orch, "projects", project);
    const wdir = resolve(orch, "worktrees", project, "feat");
    mkdirSync(pdir, { recursive: true });
    mkdirSync(wdir, { recursive: true });

    writeFileSync(resolve(pdir, ".env"), "PORT=3100\nROOT_URL=http://localhost:3100\n");
    writeFileSync(resolve(wdir, ".env.worktree"), "PORT=3140\nRSPACK_DEVSERVER_PORT=8126\nHMR_PUBLIC_PORT=8126\nROOT_URL=http://localhost:3140\n");

    const out = await renderEnvFile(orch, project, "feat", "host.docker.internal");
    const content = await Bun.file(out).text();
    expect(content).toContain("PORT=3140\n");
    expect(content).toContain("RSPACK_DEVSERVER_PORT=8126\n");
    expect(content).toContain("HMR_PUBLIC_PORT=8126\n");
    expect(content).toContain("ROOT_URL=http://localhost:3140\n");
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("shInherit: non-zero code → error with the command and the code", async () => {
  const err = await shInherit(["sh", "-c", "exit 3"]).then(
    () => null,
    (e: Error) => e,
  );
  expect(err!.message).toContain("code 3");
  expect(err!.message).toContain("sh -c exit 3");
});

test("shInherit: the hint for the exit code ends up in the error text", async () => {
  const err = await shInherit(["sh", "-c", "exit 125"], { 125: "name taken — docker rm -f wtdev-x" }).then(
    () => null,
    (e: Error) => e,
  );
  expect(err!.message).toContain("name taken — docker rm -f wtdev-x");
});

test("shInherit: a hint for a different code is not mixed in", async () => {
  const err = await shInherit(["sh", "-c", "exit 1"], { 125: "must not appear" }).then(
    () => null,
    (e: Error) => e,
  );
  expect(err!.message).not.toContain("must not appear");
});

test("devHost returns null instead of throwing when the lookup binary is missing (scutil on Linux)", async () => {
  // Bun resolves spawn binaries against the PATH it started with, so the missing `scutil`
  // is simulated through the argv seam rather than by clearing PATH.
  expect(await devHost(["wt-test-no-such-binary", "--get", "LocalHostName"])).toBeNull();
});
