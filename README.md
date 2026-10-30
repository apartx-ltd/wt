# `wt` — worktree orchestrator engine

A Bun + TypeScript engine for **multi-branch development**: it creates isolated git
worktrees, allocates deterministic ports, layers per-worktree env, wires cross-service
meshes, and runs/​stops dev instances (host process or Docker container). The stack-specific
parts (how to install, how to run, docker mounts, isolated DB seeding) live in **plugins**;
the core is generic and config-driven.

This is the engine behind the `./scripts/wt` wrapper at the orchestrator root. **For
day-to-day use, call `./scripts/wt …`, not these packages directly** — see
[docs/worktree.md](../../docs/worktree.md) for the user-facing workflow and rules.

## Layout

A Bun workspace (`bun install` at this directory installs all packages):

| Package | Name | Responsibility |
|---------|------|----------------|
| `shared/` | `@wt/shared` | Cross-cutting helpers/types shared by all packages |
| `core/` | `@wt/core` | Generic engine: worktrees, port ledger, run-state, env generation, config + plugin contract |
| `cli/` | `@wt/cli` | The `wt` command-line entrypoint (`cli/bin/wt.ts`) |
| `server/` | `@wt/server` | HTTP/JSON status server backing the web dashboard |
| `tui/` | `@wt/tui` | Full-screen terminal UI (opentui/SolidJS) — `wt ui` |
| `web/` | `@wt/web` | Web dashboard (SvelteKit + apartx-ui) — `wt web` |
| `plugins/meteor/` | `@apartx/wt/plugin-meteor` | Meteor stack plugin (install/run/docker/isolated-db) |
| `plugins/node/` | `@apartx/wt/plugin-node` | Generic Node stack plugin (`npm install` / `npm run dev -- --port`, inline env) — default for bare repos |
| `plugins/registry/` | `@wt/plugins` | Bundled-plugin registry (`registerBundledPlugins()`), wired at entrypoints |

**Dependency direction** (acyclic): `cli/server/tui → @wt/plugins → {@wt/core, @apartx/wt/plugin-meteor}`,
`@apartx/wt/plugin-meteor → @wt/core → @wt/shared`. The core **never imports a plugin** — plugins are
resolved at runtime from a registry, so the engine stays stack-agnostic.

## Commands

Run via the wrapper (`./scripts/wt <cmd>`); the CLI dispatches every command except `ui`/`web`
(which `cd` into their package dir and run directly).

```
new <project> <slug> [--isolated-db] [--seed]   create worktree + branch + install + .env.worktree
start <project> [slug] [--link|--server [slug]] run an instance in the background
run <project> [slug] [--link|--server [slug]]   run in the foreground (live logs, Ctrl-C)
restart <project> [slug]                         restart an instance
stop <project> [slug] | stop --all               stop instance(s)
up / down                                         start/stop the core stack
reap                                              remove all dev containers (docker mode)
logs <project> [slug] [-f] | logs --all          tail instance logs
rm <project> <slug> [--branch]                   remove a worktree
link / unlink <project> <slug> [link-slug]       repoint cross-service upstreams (mesh)
port <project> [slug]                             print the allocated port
list / ps / projects                             list worktrees / running instances / projects
ui                                                full-screen TUI dashboard
web                                               web dashboard (wt-server + vite dev)
help                                              command help
```

## Configuration

The workspace is described declaratively in `<orchestrator-root>/wt.config.ts`. Each project
selects a `StackPlugin`; defaults are deep-merged into every project:

```ts
import { defineWorkspace } from "./tools/wt/core/src/config";

export default defineWorkspace({
  projectsDir: "projects",                       // multi-repo (or `project: {…}` for single-repo)
  ports: { step: 10 },
  branches: { base: "develop", prefix: "feature/" },
  defaults: { plugin: "@apartx/wt/plugin-meteor" },
  projects: {
    "apartx-server":  { docker: { image: "meteor-dev:3.4" }, core: { slug: "base" } },
    "apartx-spaces":  {},                          // host-mode meteor (no docker)
  },
  links: ["apartx-cabinet:apartx-server:env:SERVER_URL", /* … */],
});
```

A project not listed in the config falls back to constants-derived defaults, so every repo
under `projectsDir` keeps working without being enumerated.

### Plugins (`StackPlugin`)

A plugin **describes**, the core **executes**. A plugin returns command descriptors
(`{argv}`), env lines, docker mounts, and isolated-db helpers; the core builds the dotenvx /
docker wrappers and runs them. Key surface (see `core/src/plugin.ts`):

```ts
interface StackPlugin {
  name: string;
  envInjection?: "dotenvx" | "inline";
  install(ctx): Command;
  devCommand(ctx): Command;                       // mode-aware: host "$PORT" vs docker literal
  envLines?(ctx): string[];
  extraPorts?: string[];                          // e.g. ["hmr"] — core allocates one per name
  settingsFile?(ctx): string;
  isolatedDb?: { urlEnvKey; deriveUrl; seed? };
  docker?(ctx): { mounts; addHosts?; ownedVolumes? };
}
```

Bundled plugins are registered in `plugins/registry` and exposed via `registerBundledPlugins()`,
called once at each process entrypoint.

### `.env.worktree` lifecycle (self-heal on start)

`wt start` / `wt run` **regenerate** a worktree's `.env.worktree` on every start: the
wt-managed keys (`PORT`, `ROOT_URL`, the plugin's `envLines`/`worktreeEnvTail`, and — only
when already present — the isolated-DB `urlEnvKey`) are rewritten to current deterministic
values, while the isolated-DB `MONGO_URL` and any manual/non-managed keys are **preserved
verbatim**. Isolated-vs-shared is inferred from whether the URL key is present, so a
regenerate **never** flips a worktree between isolated and shared databases. The regenerate is
idempotent on a canonically-generated file, so fresh worktrees are byte-identical — only
stale/legacy files (e.g. those written by the old `scripts/worktree-env.sh`, missing the HMR
keys) get healed. For persistent custom env prefer the `var/env/<p>-<slug>.env` link overlay,
which wins over `.env.worktree`. Base checkouts (slug `base`, no `.env.worktree`) get the
plugin's HMR env injected at `docker run` time (`-e`).

## Development

```bash
bun install                       # from tools/wt — installs all workspace packages
bun test                          # full suite
bun run typecheck                 # bunx tsc --noEmit
```

**Gate (must pass before commit):** `cd tools/wt && bun test && bun run typecheck`.

> After pulling changes that add/rename a workspace package, run `bun install` again to
> materialize the new symlinks — otherwise tests fail with `Cannot find module '@wt/…'`.

## Status & roadmap

The engine is a strangler migration of the legacy bash `wt` (`scripts/wt-legacy`, removed in
earlier M4 work). Config + plugin foundation is complete:

- **M0+M1 (done):** `StackPlugin` interface + config layer; all Meteor specifics extracted into
  `@apartx/wt/plugin-meteor`; apartx runs through the config+plugin path with byte-identical behavior.
- **M2 (done):** `DOCKERIZED`/`DEV_IMAGE` deleted — dockerized detection and image come from `config.docker.image`.
- **M2.5 (done):** branch convention (`branches.{base,prefix}`), core stack (`core.slug`), and link mesh (`links`) all come from config; the base-checkout slug is renamed `"main"`→`"base"` (one-time run-state migration); `wt new` forks explicitly from `branches.base`, and `wt up` starts the base checkouts of the core projects.
- **M2.6 (done):** plugin↔core boundary hermeticized (parity, byte-identical via `parity.test.ts`) — `METEOR_WATCH_*` → `plugin.docker().env`, mongo `directConnection` → `plugin.docker().envLineFilter`, `MONTI_*`/`MONGO_OPLOG_URL=`/isolated-`MONGO_URL` → `plugin.worktreeEnvTail()` + `isolatedDb.deriveUrl`, and `StartOptions.link` relaxed `"all"|"apartx-server"`→`"all"|string` (last apartx literal out of core); HMR base-port generalization deferred to M3.
- **M3 (done):** `@apartx/wt/plugin-node` shipped (generic `npm install` / `npm run dev -- --port`, inline env); the hardcoded HMR port generalized into a stack-agnostic `ExtraPortSpec` (meteor declares its own `hmr`/`8085`/`RSPACK_DEVSERVER_PORT`, core has zero stack literals); inline env-injection layers `.env`/`.env.worktree` in core so a non-`dotenvx` plugin runs detached; single-repo path resolution (`projectsDir "."` → repo root) wired through `new`/`start`/`port`/`list`; proven end-to-end by `core/test/single-repo.test.ts` driving a bare node repo with zero apartx knowledge.
- **M4 (done):** OSS polish (*pragmatic core*) — plugin `apiVersion` + load-time compat check,
  configurable workspace `title` surfaced to both frontends, config-driven (de-hardcoded)
  `--server` link target (`config.serverProject`), single-repo CLI ergonomics (drop the
  redundant `<project>` arg), and a published `wt.config` JSON Schema. `wt-legacy` removal and
  config/plugin type exports (`@wt/core/config`, `@wt/core/plugin`) were already done earlier.
  **Deferred** (only pay off after repo extraction): npm plugin-resolution (the bundled
  registry stays), out-of-tree single-repo worktrees (worktrees stay in `orch/worktrees/`),
  and `settings:`-mechanism genericization for non-Meteor. See the subsections below.

### M4 features

#### Plugin `apiVersion`

The plugin↔core contract is versioned. `@wt/core/plugin` exports `PLUGIN_API_VERSION` (`= 1`)
and `StackPlugin` gains an optional `apiVersion?: number`. `loadPlugin` enforces it as
**required at load time**: it throws unless `plugin.apiVersion === PLUGIN_API_VERSION` (the
type is optional only so inline test fakes that bypass `loadPlugin` keep compiling). A future
core bump can refuse an incompatible third-party plugin instead of misbehaving silently.
Bundled plugins declare it:

```ts
import { PLUGIN_API_VERSION, type StackPlugin } from "@wt/core/plugin";

export const myPlugin: StackPlugin = {
  name: "my-stack",
  apiVersion: PLUGIN_API_VERSION,
  // …install/devCommand/…
};
```

#### Configurable `title`

`wt.config.title` is surfaced to both frontends via the server: `GET /api/meta` returns
`{ title }`, the `@wt/shared` client exposes `getMeta()`, and the TUI + web dashboard render
`wt · <title>` (fallback `wt · worktrees` when unset). Frontends never read the filesystem —
the server is the single place that loads `wt.config`.

#### Config-driven `--server`

`--server` is a shorthand for repointing the cabinet-style upstream at a specific project's
same-slug worktree. Its target now comes from config instead of a hardcoded literal — set
`serverProject` in `wt.config.ts`:

```ts
export default defineWorkspace({
  // …
  serverProject: "apartx-server",   // `wt start <project> <slug> --server` links this upstream
});
```

`wt start … --server` resolves `serverProject` and dies if it is unset. (`--link` still
repoints *all* configured upstreams.)

#### Single-repo CLI ergonomics

In a single-repo workspace (`projectsDir: "."` with one project) the `<project>` arg is
implicit — it's the repo itself — so it can be omitted:

```bash
wt new <slug>          # multi-repo: wt new <project> <slug>
wt start [slug]        # multi-repo: wt start <project> [slug]
wt port [slug]         # …and likewise for run/restart/stop/logs/rm/link/unlink/port
```

Multi-repo workspaces (e.g. apartx) are unchanged — the first positional is still the project.

#### JSON Schema for `wt.config`

A draft-07 JSON Schema for the workspace config lives at `core/schema/wt.config.schema.json`
and is exported as `@wt/core/config-schema`. Configs remain `.ts` (typed via `defineWorkspace`);
the schema is for **external tooling** (editors, validators, generators) that can't consume the
TypeScript types directly.

Design + plans: [docs/plans/2026-06-21-wt-universal-plugin/](../../docs/plans/2026-06-21-wt-universal-plugin/),
[docs/plans/2026-06-20-wt-engine-port/](../../docs/plans/2026-06-20-wt-engine-port/).
