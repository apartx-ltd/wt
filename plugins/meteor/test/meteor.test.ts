import { test, expect } from "bun:test";
import { meteorPlugin } from "../src/index";
import { PLUGIN_API_VERSION } from "#core/plugin";

test("meteor plugin declares the current apiVersion", () => {
  expect(meteorPlugin.apiVersion).toBe(PLUGIN_API_VERSION);
});

test("meteor plugin: install is meteor npm install; extraPorts=[hmr]", () => {
  expect(meteorPlugin.install({} as any).argv).toEqual(["meteor", "npm", "install"]);
  expect(meteorPlugin.extraPorts).toEqual([
    { name: "hmr", basePort: 8085, envKey: "RSPACK_DEVSERVER_PORT" },
  ]);
});

test("meteor devCommand: docker mode = literal port; host mode = $PORT", () => {
  expect(meteorPlugin.devCommand({ mode: "docker", port: 4010 } as any).argv)
    .toEqual(["meteor", "run", "--port", "4010"]);
  expect(meteorPlugin.devCommand({ mode: "host", port: 4010 } as any).argv)
    .toEqual(["meteor", "run", "--port", "$PORT"]);
});

test("meteor devCommand: settings flag syntax differs by mode", () => {
  expect(meteorPlugin.devCommand({ mode: "host", port: 4010, settingsPath: "/abs/settings.json" } as any).argv)
    .toEqual(["meteor", "run", "--settings=/abs/settings.json", "--port", "$PORT"]);
  expect(meteorPlugin.devCommand({ mode: "docker", port: 4010, settingsPath: ".wt-settings.json" } as any).argv)
    .toEqual(["meteor", "run", "--settings", ".wt-settings.json", "--port", "4010"]);
});

test("meteor envLines emits RSPACK_DEVSERVER_PORT and HMR_PUBLIC_PORT from extraPorts.hmr", () => {
  const lines = meteorPlugin.envLines!({ extraPorts: { hmr: 8105 } } as any);
  expect(lines).toEqual(["RSPACK_DEVSERVER_PORT=8105", "HMR_PUBLIC_PORT=8105"]);
});

test("meteor envLines returns no HMR lines when extraPorts.hmr is absent (host-mode)", () => {
  expect(meteorPlugin.envLines!({ extraPorts: {} } as any)).toEqual([]);
});

test("meteor docker() returns the meteor volume mounts + owned volumes for wt rm", () => {
  const d = meteorPlugin.docker!({ container: "wtdev-p-s", worktreeDir: "/o/wt/p/s" } as any);
  expect(d.mounts).toContain("/o/wt/p/s:/opt/app");
  expect(d.mounts).toContain("wtdev-p-s-node_modules:/opt/app/node_modules");
  expect(d.mounts).toContain("meteor_base:/root");
  expect(d.ownedVolumes).toEqual(["wtdev-p-s-node_modules", "wtdev-p-s-meteor_local"]);
});

test("docker().env carries the meteor watch-polling vars", () => {
  const spec = meteorPlugin.docker!({ container: "wtdev-p-s", worktreeDir: "/o/wt/p/s" } as any);
  expect(spec.env).toEqual({
    METEOR_WATCH_FORCE_POLLING: "true",
    METEOR_WATCH_POLLING_INTERVAL_MS: "500",
  });
});

test("docker().envLineFilter injects mongo directConnection idempotently", () => {
  const f = meteorPlugin.docker!({ container: "wtdev-p-s", worktreeDir: "/o/wt/p/s" } as any).envLineFilter!;
  expect(f("MONGO_URL=mongodb://h/db")).toBe("MONGO_URL=mongodb://h/db?directConnection=true");
  expect(f("MONGO_URL=mongodb://h/db?x=1")).toBe("MONGO_URL=mongodb://h/db?x=1&directConnection=true");
  expect(f("MONGO_URL=mongodb://h/db?directConnection=true")).toBe("MONGO_URL=mongodb://h/db?directConnection=true");
  expect(f("PORT=3000")).toBe("PORT=3000");
});

test("worktreeEnvTail returns the meteor blank tail lines in order", () => {
  expect(meteorPlugin.worktreeEnvTail!({} as any)).toEqual([
    "MONGO_OPLOG_URL=",
    "MONTI_APP_ID=",
    "MONTI_APP_SECRET=",
  ]);
});

test("meteor isolatedDb derives <db>_<suffix> and declares MONGO_URL as the url key", () => {
  expect(meteorPlugin.isolatedDb!.urlEnvKey).toBe("MONGO_URL");
  expect(meteorPlugin.isolatedDb!.deriveUrl("mongodb://h:27017/apartx", "feat_x"))
    .toBe("mongodb://h:27017/apartx_feat_x");
});

test("meteor isolatedDb.seed dumps base and restores into the isolated db", async () => {
  const calls: string[][] = [];
  const ctx = {
    baseDbUrl: "mongodb://h:27017/apartx",
    isolatedDbUrl: "mongodb://h:27017/apartx_feat_x",
    run: async (argv: string[]) => { calls.push(argv); },      // typed seam (SeedCtx.run)
  } as any;
  await meteorPlugin.isolatedDb!.seed!(ctx);
  expect(calls[0][0]).toBe("mongodump");
  expect(calls[0].join(" ")).toContain("--uri=mongodb://h:27017/apartx");
  expect(calls[1][0]).toBe("mongorestore");
  expect(calls[1].join(" ")).toContain("--uri=mongodb://h:27017/apartx_feat_x");
  expect(calls[1]).toContain("--drop");
});

test("meteor plugin: восстанавливаемые каталоги для wt slim — node_modules и .meteor/local", () => {
  expect(meteorPlugin.artifactDirs).toEqual(["node_modules", ".meteor/local"]);
});
