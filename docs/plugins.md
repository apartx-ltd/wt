# Plugins

A stack plugin tells `wt` how a project of a given stack is installed, started and
containerized. **The plugin describes, the core executes:** a plugin returns command
descriptors (`{ argv }`), env lines, Docker mounts and database helpers; the core allocates
ports, builds the env and Docker wrappers, runs the commands and tracks the instances. The core
never imports a plugin — plugins are looked up by id in a registry.

A project picks its plugin in `wt.config.ts` (`plugin`, or `defaults.plugin`):

| Id | Plugin |
|----|--------|
| `"@apartx/wt/plugin-node"` | [Node](#node--apartxwtplugin-node) |
| `"@apartx/wt/plugin-meteor"` | [Meteor](#meteor--apartxwtplugin-meteor) |

The pre-release ids `"@wt/plugin-node"` and `"@wt/plugin-meteor"` are rejected with a
`renamed to …` error. Only the bundled plugins can be loaded in this release; loading a
third-party plugin from its own package is planned, and the contract below is what it will
implement.

## The `StackPlugin` contract

The contract lives in `core/src/plugin.ts` and is exported as `@apartx/wt/plugin`:

```ts
import { PLUGIN_API_VERSION, type StackPlugin } from "@apartx/wt/plugin";

export const myPlugin: StackPlugin = {
  name: "my-stack",
  apiVersion: PLUGIN_API_VERSION,
  envInjection: "inline",
  install: () => ({ argv: ["npm", "install"] }),
  devCommand: (ctx) => ({ argv: ["npm", "run", "dev", "--", "--port", String(ctx.port)] }),
};
```

| Member | Purpose |
|--------|---------|
| `name: string` | Short name of the stack (`"node"`, `"meteor"`). |
| `apiVersion?: number` | Contract version the plugin was written against. Loading fails unless it equals `PLUGIN_API_VERSION` (currently `1`), so a core with an incompatible contract refuses the plugin instead of misbehaving. |
| `envInjection?: "dotenvx" \| "inline"` | How a host instance gets its env. `"inline"` (default): the core merges the env files into the process environment. `"dotenvx"`: the core wraps the dev command in `npx dotenvx run -f … -- sh -c "<command>"`. See [Env layering](#env-layering). |
| `install(ctx): Command` | Dependency install — run by `wt new`, and again by `wt start`/`wt run` when `node_modules` is missing or stale (e.g. after `wt slim`). Runs in the worktree on the host, or in docker mode in a throwaway container from the project's image with the plugin's mounts. |
| `artifactDirs?: string[]` | Worktree directories that `install`/build restore (e.g. `node_modules`); `wt slim` deletes them in stopped worktrees. |
| `devCommand(ctx): Command` | The dev server command. It must listen on `ctx.port`; in host mode the command runs as `sh -c "<argv joined>"`, so `$PORT` works there, while in docker mode it should use the literal `ctx.port` (`ctx.mode` tells which). |
| `envLines?(ctx): string[]` | `KEY=value` lines written to `.env.worktree` right after `PORT` (Meteor: the HMR port). For a dockerized base checkout they are passed as `docker run -e`. |
| `worktreeEnvTail?(ctx): string[]` | Static lines appended to `.env.worktree` after `ROOT_URL`. |
| `extraPorts?: ExtraPortSpec[]` | Additional ports per instance, `{ name, basePort, envKey? }`. The core allocates one port per spec (base + the project's index among the dockerized projects + the worktree offset), puts it in `ctx.extraPorts[name]` and publishes it in docker mode. A port is allocated only for a dockerized project or when `envKey` is set in the project's `.env`, which then overrides `basePort`. |
| `isolatedDb?` | `{ urlEnvKey, deriveUrl(baseUrl, suffix), seed?(ctx) }` — support for `wt new --isolated-db [--seed]`: the worktree's `.env.worktree` gets `<urlEnvKey>=deriveUrl(<base URL>, <branchSuffix>)`; `seed` copies the base database into it, building argv and calling `ctx.run(argv)`, which the core executes. |
| `docker?(ctx)` | Container layout for projects with `docker: { image }`: `mounts` (`-v`; the container's working directory is `/opt/app`, so the worktree is mounted there), `addHosts` (`--add-host`), `ownedVolumes` (per-worktree named volumes that `wt slim` may remove), `env` (static `-e KEY=VALUE`), `envLineFilter` (a per-line transform of the container's env, applied after the core's own `localhost` → host remap). |
| `resolveBasePort?(projectDir)`, `settingsFile?(ctx)` | Declared in the contract but not called by the current core: the base port comes from the project's `.env` / `package.json`, and the settings path is computed by the core (`ctx.settingsPath`). |

`Command` is `{ argv: string[]; cwd?: string; env?: Record<string, string> }`. With inline
injection, `Command.env` is added on top of the layered env.

### Contexts

Every hook receives a context built by the core:

| Field | In | Meaning |
|-------|----|---------|
| `orch` | all | Workspace root. |
| `project`, `slug`, `branch` | all | The instance: project name, slug (`"base"` for the base checkout), git branch. |
| `projectDir` | all | The base checkout, `projects/<p>` (the workspace root in single-repo). |
| `worktreeDir` | all | The worktree (`worktrees/<p>/<slug>`), or the base checkout for slug `base`. |
| `config` | all | The project's resolved `ProjectConfig` (after `defaults`). |
| `port`, `offset` | instance | The instance's port and its offset from the base port. |
| `container` | instance | Container name, `wtdev-<p>-<slug>`. |
| `mode` | instance | `"host"` or `"docker"`. |
| `settingsPath` | instance | Settings file for the dev command, or `null`. Host: the link overlay, else the repo's `settings/settings.json` / `settings.json`. Docker: a rendered copy mounted at `/opt/app/.wt-settings.json`. |
| `extraPorts` | instance | Allocated extra ports by spec name. |
| `baseDbUrl`, `isolatedDbUrl`, `run(argv)` | seed | Source and target database URLs, and the core's command runner. |

In `wt new`, `install` gets an instance context with `port: 0`; `envLines` and `worktreeEnvTail` get it with
the worktree's port and offset.

`@apartx/wt/plugin` also exports `mongoDirectConnectionFilter`, an `envLineFilter` that appends
`directConnection=true` to `MONGO_URL` / `MONGO_OPLOG_URL`: a containerized app connecting to a
MongoDB replica set on the host would otherwise follow the replica set's `127.0.0.1` member
address back into the container.

## Bundled plugins

### Node — `@apartx/wt/plugin-node`

For any Node project with a `dev` script that accepts `--port`.

- install: `npm install`; `wt slim` removes `node_modules`.
- dev: `npm run dev -- --port <port>`, inline env injection.
- docker: the worktree at `/opt/app`, `node_modules` in a named volume per worktree (host
  binaries would not match the Linux container), `host.docker.internal` resolvable,
  `mongoDirectConnectionFilter`. Binding to an external interface inside the container (e.g.
  vite's `server.host`) is up to the project.
- no isolated database support.

### Meteor — `@apartx/wt/plugin-meteor`

For Meteor apps.

- install: `meteor npm install`; `wt slim` removes `node_modules` and `.meteor/local`.
- dev: `meteor run [--settings …] --port <port>`, dotenvx env injection (the project needs
  `@dotenvx/dotenvx` installed).
- extra port `hmr`: base `8085`, overridden by `RSPACK_DEVSERVER_PORT` in `.env`; written to
  `.env.worktree` as `RSPACK_DEVSERVER_PORT` and `HMR_PUBLIC_PORT`.
- `.env.worktree` tail: empty `MONGO_OPLOG_URL=`, `MONTI_APP_ID=`, `MONTI_APP_SECRET=`.
- isolated database: `--isolated-db` derives `MONGO_URL` with the database renamed to
  `<db>_<branchSuffix>`; `--seed` copies the base database into it with `mongodump` /
  `mongorestore`.
- docker: the worktree at `/opt/app`, `node_modules` and `.meteor/local` in named volumes per
  worktree, a shared `meteor_base` volume at `/root`, polling file watching,
  `mongoDirectConnectionFilter`.
- settings links: the linked settings file is passed as `--settings`.

## Env layering

An instance sees, from highest to lowest precedence:

1. the link overlay `var/env/<p>-<slug>.env` (written by `--link` / `--server` / `wt link`);
2. the worktree's `.env.worktree` (worktrees only — the base checkout has none);
3. the project's `.env` in the base checkout `projects/<p>/.env` — worktrees share it, it is
   not copied.

`PORT` is also set in the process environment, so a base checkout whose `.env` has no `PORT`
still gets the resolved port.

- **Host, inline** (Node): the core merges the three files into the environment of
  `sh -c "<dev command>"`.
- **Host, dotenvx** (Meteor): `npx dotenvx run -f <overlay> -f .env.worktree -f <base .env> --
  sh -c "<dev command>"`.
- **Docker**: the core renders the merged env with `npx dotenvx` in the base checkout, rewrites
  `localhost` / `127.0.0.1` to the host's address in every value except `ROOT_URL`, applies the
  plugin's `envLineFilter`, and passes the result as `--env-file`
  (`var/run/<p>-<slug>.env.merged`). This needs `@dotenvx/dotenvx` installed in the base
  checkout.

## `.env.worktree` lifecycle

`wt new` writes `.env.worktree` into the worktree:

```
# GENERATED by wt — managed keys are rewritten on every start; custom keys are preserved
# project=storefront  branch=feature/my-feature  offset=20
PORT=3120
<plugin envLines>
ROOT_URL=http://localhost:3120
<plugin worktreeEnvTail>
<isolated-db urlEnvKey, with --isolated-db>
<project env from wt.config.ts>
```

`ROOT_URL` keeps the host of the base `.env`'s `ROOT_URL` (default `localhost`) with the
worktree's port.

`wt start` / `wt run` / `wt restart` **regenerate** it on every start (self-heal):

- the wt-managed keys — `PORT`, `ROOT_URL`, the plugin's `envLines` and `worktreeEnvTail`, the
  project's `env` from `wt.config.ts` and, only when already present, the isolated-db
  `urlEnvKey` — are rewritten to their current deterministic values;
- every other key (anything you added by hand) is preserved verbatim.

Isolated vs shared database is inferred from whether the `urlEnvKey` line is present, so a
regenerate never switches a worktree between an isolated and the shared database. Regenerating
a freshly generated file changes nothing; only stale files (written by an older `wt`, or by a
config that has since changed) are healed.

For persistent custom env prefer the link overlay `var/env/<p>-<slug>.env`, which wins over
`.env.worktree`. A dockerized base checkout (slug `base`, no `.env.worktree`) gets the plugin's
`envLines` as `docker run -e`.
