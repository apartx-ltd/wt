import { PLUGIN_API_VERSION, mongoDirectConnectionFilter, type StackPlugin } from "#core/plugin";

/**
 * Generic Node plugin (the default for a bare repo): `npm install` / `npm run dev -- --port <port>`.
 * Inline env injection (the core layers .env/.env.worktree), no isolated-db.
 *
 * `docker()` describes the container layout for projects that declare `docker: {image}`
 * in wt.config: the repo is mounted at /opt/app, node_modules lives in a named volume (otherwise
 * the host's macOS binaries would not match the linux container). No meteor volumes —
 * this is a plain node stack. The block is not used in host mode.
 *
 * The flag for listening on an external interface (`--host` for vite etc.) is NOT added here:
 * it is not universal across the node stack. A project that runs in a container declares
 * it itself (e.g. `server.host` in vite.config).
 */
export const nodePlugin: StackPlugin = {
  name: "node",
  apiVersion: PLUGIN_API_VERSION,
  envInjection: "inline",
  install: () => ({ argv: ["npm", "install"] }),
  artifactDirs: ["node_modules"],
  devCommand: (ctx) => ({ argv: ["npm", "run", "dev", "--", "--port", String(ctx.port)] }),
  docker: (ctx) => ({
    mounts: [
      `${ctx.worktreeDir}:/opt/app`,
      `${ctx.container}-node_modules:/opt/app/node_modules`,
    ],
    addHosts: ["host.docker.internal:host-gateway"],
    ownedVolumes: [`${ctx.container}-node_modules`],
    envLineFilter: mongoDirectConnectionFilter,
  }),
};

export default nodePlugin;
