# AGENTS.md — working on `wt` itself

This file is for coding agents (and humans) changing this repository. If you are setting up
`wt` in a *workspace* or writing instructions for agents that *use* `wt`, read
[docs/agents.md](docs/agents.md) instead.

## What this is

`@apartx/wt` — a Bun-only CLI (`wt`) that manages git worktrees, deterministic ports,
per-worktree env, cross-service links and dev instances (host processes or Docker containers),
with a terminal dashboard (`wt ui`) and a web dashboard (`wt web`) served by a local HTTP
daemon. One npm package, no build step: Bun runs the TypeScript sources directly.

## Layout

| Directory | Contents | Imported as |
|-----------|----------|-------------|
| `cli/` | `bin/wt.ts` — the command table, USAGE and `main()`; `src/args.ts`, `src/dashboards.ts` | — |
| `core/` | the engine: config loading and validation, workspace discovery (`orch.ts`), ports, worktrees, instances, links, env layering, sweep/slim; `schema/wt.config.schema.json` | `#core` |
| `shared/` | types and the HTTP client shared by server, TUI and web; `WT_PROTOCOL_VERSION` | `#shared` |
| `server/` | the wt-server daemon (`Bun.serve`): REST + SSE API, static dashboard, spawns the CLI | — |
| `tui/` | the opentui/Solid terminal dashboard; `src/server-boot.ts` finds or replaces the daemon | — |
| `web/` | the SvelteKit dashboard (static SPA); only `web/build` ships in the package | — |
| `plugins/` | `registry/` (plugin ids → implementations), `meteor/`, `node/` | `#plugins`, `#plugin-meteor`, `#plugin-node` |
| `docs/` | `config.md`, `plugins.md`, `agents.md` | — |

Tests live next to their package in `*/test/`. `index.ts` is the public entry
(`defineWorkspace`, config types); `package.json` `exports` are the only public import paths.

## Commands

```bash
bun install            # also fetches the web UI kit from GitHub (network + git)
bun test               # 369 tests, real temp workspaces and real git — no mocks of git/fs
bun run typecheck      # tsc --noEmit
bun run e2e            # TUI end-to-end flows via @opentui/solid testRender (run with `bun`, not `bun test`)
bun run build:web      # web/build, served by `wt web`; `prepack` runs it on publish
bun pm pack --dry-run  # what the npm tarball would contain
bun link               # the global `wt` runs this checkout (dev mode)
```

Run a command against a scratch workspace without installing anything:
`WT_ORCH=/tmp/ws bun cli/bin/wt.ts projects` (or `cd /tmp/ws && bun ~/Projects/wt/cli/bin/wt.ts …`).

## Rules

- **Tests first, real behavior.** A change to the engine gets a test in the matching
  `*/test/` file that creates a temp workspace (`mkdtempSync`) with an inline `wt.config.ts` and
  real git repositories — copy the style of `core/test/orch.test.ts` or `cli/test/no-workspace.test.ts`.
  Server tests listen on port 0. Never start a daemon on 4499 from a test, never touch the
  developer's real workspaces, never leave processes behind.
- **Everything in English** — code, comments, messages, docs, commits. Check with
  `LC_ALL=en_US.UTF-8 git grep -P "[А-Яа-я]"` (must be empty).
- **Keep the public surface deliberate.** New config fields go into `core/src/config.ts`
  (types + `validateConfig`), the JSON schema, `docs/config.md` and `index.ts` together.
  Plugin ids are `@apartx/wt/plugin-<name>`; the registry in `plugins/registry/` is the only
  place that maps them. Removing or renaming anything public is a breaking change — say so in
  `History.md`.
- **Security of the daemon is a feature.** The wt-server binds `127.0.0.1` and rejects
  cross-origin writes; a change to `server/src/index.ts` request handling needs a test for the
  rejected case too. Bump `WT_PROTOCOL_VERSION` in `shared/src/types.ts` when the client/server
  contract changes, so running daemons are replaced instead of reused.
- **Conventional commits**, one concern per commit (`fix(server): …`, `feat(core): …`,
  `docs: …`). No attribution trailers.
- **Release**: bump `version` in `package.json`, add the entry to `History.md`, commit, tag
  `v<version>` and push the tag — `.github/workflows/release.yml` tests, packs and publishes
  (it refuses a tag that does not match `package.json`).
- Use `git grep`, not `rg` with globs (hangs in some agent sandboxes).

## Where things can bite

- `wt.config.ts` of a consumer imports `@apartx/wt` with no `node_modules`: `core/src/self-resolve.ts`
  registers a `Bun.plugin` virtual module per `exports` entry. Touch `exports` and that test together.
- Workspace discovery walks up from `cwd` to the first `wt.config.ts` (`core/src/orch.ts`); the
  daemon is bound to one workspace via `WT_ORCH` and `/api/meta`. The CLI, the server and the TUI
  pass `WT_ORCH` along when they spawn each other.
- Ports: offsets are multiples of `ports.step` (default 10), recorded in `var/worktree-ports.tsv`
  of the workspace and never reused for a different branch. Any change to allocation must keep
  existing ledgers meaning the same thing.
- `web/` depends on the `apartx-ui` kit as a git devDependency pinned to a commit; svelte-check
  noise inside the kit is not ours. The kit is not in the published package.
- Docker mode uses the machine's mDNS name (`scutil`, macOS); Linux falls back to
  `host.docker.internal` and is untested.
