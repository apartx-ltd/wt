import { PLUGIN_API_VERSION, type StackPlugin } from "#core/plugin";

/**
 * pnpm plugin: `pnpm install --frozen-lockfile` / `pnpm dev`, for a pnpm workspace (monorepo)
 * or a single package managed by pnpm.
 *
 * The port is not passed on the command line: `pnpm dev` of a workspace usually fans out to
 * several packages (turbo, `pnpm -r`), and a `--port` flag would reach all of them or none.
 * The core puts the resolved `PORT` into the instance environment, so the project reads `PORT`
 * and derives any secondary ports itself (e.g. from an offset it gets through `env` in
 * `wt.config.ts`).
 *
 * `--frozen-lockfile`: a worktree must install exactly what the branch's lock file says; a
 * silent lock rewrite in a fresh worktree would show up as an unrelated diff.
 *
 * Host mode only for now — no `docker()`. Only the root `node_modules` is tracked as the
 * install marker and as the `wt slim` artifact; per-package `node_modules` are links into it.
 */
export const pnpmPlugin: StackPlugin = {
  name: "pnpm",
  apiVersion: PLUGIN_API_VERSION,
  envInjection: "inline",
  install: () => ({ argv: ["pnpm", "install", "--frozen-lockfile"] }),
  deps: { dir: "node_modules", files: ["package.json", "pnpm-lock.yaml"] },
  artifactDirs: ["node_modules"],
  devCommand: () => ({ argv: ["pnpm", "dev"] }),
};

export default pnpmPlugin;
