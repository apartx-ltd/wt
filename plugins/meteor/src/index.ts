import { PLUGIN_API_VERSION, mongoDirectConnectionFilter, type StackPlugin } from "#core/plugin";

/** Meteor stack plugin. Behavior is at parity with the core's inline logic before M1 (see parity.test.ts). */
export const meteorPlugin: StackPlugin = {
  name: "meteor",
  apiVersion: PLUGIN_API_VERSION,
  envInjection: "dotenvx",
  extraPorts: [{ name: "hmr", basePort: 8085, envKey: "RSPACK_DEVSERVER_PORT" }],
  install: () => ({ argv: ["meteor", "npm", "install"] }),
  artifactDirs: ["node_modules", ".meteor/local"],
  // Port: in host mode dotenvx injects $PORT (a shell variable), in docker it is a literal.
  // Settings: host = `--settings=<path>`, docker = `--settings <path>` (the core provides path via ctx.settingsPath).
  envLines: (ctx) => {
    const hmr = ctx.extraPorts?.hmr;
    return hmr === undefined ? [] : [`RSPACK_DEVSERVER_PORT=${hmr}`, `HMR_PUBLIC_PORT=${hmr}`];
  },
  devCommand: (ctx) => {
    const port = ctx.mode === "host" ? "$PORT" : String(ctx.port);
    const settings = ctx.settingsPath
      ? ctx.mode === "host"
        ? [`--settings=${ctx.settingsPath}`]
        : ["--settings", ctx.settingsPath]
      : [];
    return { argv: ["meteor", "run", ...settings, "--port", port] };
  },
  settingsFile: (ctx) => `${ctx.worktreeDir}/.wt-settings.json`,
  worktreeEnvTail: () => ["MONGO_OPLOG_URL=", "MONTI_APP_ID=", "MONTI_APP_SECRET="],
  isolatedDb: {
    urlEnvKey: "MONGO_URL",
    deriveUrl: (baseUrl, suffix) => baseUrl.replace(/(\/[^/?]+)(\?|$)/, `$1_${suffix}$2`),
    seed: async (ctx) => {
      const { mkdtemp, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { resolve } = await import("node:path");
      const dump = await mkdtemp(resolve(tmpdir(), "wt-seed-"));
      const srcDb = ctx.baseDbUrl.replace(/^mongodb(\+srv)?:\/\/[^/]+\//, "").split("?")[0]!.split("/")[0]!;
      try {
        await ctx.run(["mongodump", `--uri=${ctx.baseDbUrl}`, `--out=${dump}`, "--quiet"]);
        await ctx.run(["mongorestore", `--uri=${ctx.isolatedDbUrl}`, "--drop", "--quiet", resolve(dump, srcDb)]);
      } finally {
        await rm(dump, { recursive: true, force: true });
      }
    },
  },
  docker: (ctx) => ({
    env: { METEOR_WATCH_FORCE_POLLING: "true", METEOR_WATCH_POLLING_INTERVAL_MS: "500" },
    mounts: [
      `${ctx.worktreeDir}:/opt/app`,
      `${ctx.container}-node_modules:/opt/app/node_modules`,
      `${ctx.container}-meteor_local:/opt/app/.meteor/local`,
      "meteor_base:/root",
    ],
    addHosts: ["host.docker.internal:host-gateway"],
    ownedVolumes: [`${ctx.container}-node_modules`, `${ctx.container}-meteor_local`],
    envLineFilter: mongoDirectConnectionFilter,
  }),
};

export default meteorPlugin;
