# wt

**Multi-branch development with git worktrees.** `wt` gives every branch of every service its
own git worktree, a deterministic port, a per-worktree env layered over the project's `.env`,
and links to the same-branch worktrees of the services it talks to. Instances run as host
processes or Docker containers, side by side with the base checkouts, so you can work on a
feature, review a colleague's branch and keep `main` running at the same time — without
editing env files or picking ports by hand.

The engine is generic and driven by one `wt.config.ts` at the workspace root. What is
stack-specific (how to install dependencies, how to start the dev server, Docker mounts,
isolated databases) lives in plugins; Node, Meteor and Rust plugins are bundled. A terminal UI
(`wt ui`) and a web dashboard (`wt web`) show what runs where.

## Install

```bash
bun install -g @apartx/wt
wt --version
```

Requirements:

- [Bun](https://bun.sh) 1.3 or newer — `wt` runs on Bun only (Node is not supported).
  `~/.bun/bin` must be on your `PATH`.
- git.
- Optional: Docker, for projects that declare `docker: { image }` (see
  [Limitations](#limitations) for the macOS specifics of docker mode).

`wt --version` and `wt help` work anywhere. Every other command needs a workspace: `wt` walks up
from the current directory to the first `wt.config.ts` (the way git finds `.git`), so it works
from any subdirectory of the workspace. `WT_ORCH=<dir>` overrides the search. Outside a
workspace it prints `wt: no wt.config.ts found …` and exits with code 1.

## Quick start

A workspace with three services — an API, a storefront and an admin panel — each in its own
git repository:

```
my-shop/
├── wt.config.ts
└── projects/
    ├── api/          git repo, .env: PORT=3000
    ├── storefront/   git repo, .env: PORT=3100, API_URL=http://localhost:3000
    └── admin/        git repo, .env: PORT=3200, API_URL=http://localhost:3000
```

`wt` reads two things from each project's own `.env` (in the base checkout under `projects/`):
the base `PORT` (or a `PORT=NN` / `--port NN` / `-p NN` in `package.json`), and the current
value of every key a link rewrites (`API_URL` here). With the bundled Node plugin a project is
started with `npm run dev -- --port <port>`, so its `dev` script has to honor `--port`.

`my-shop/wt.config.ts`:

```ts
import { defineWorkspace } from "@apartx/wt";

export default defineWorkspace({
  title: "my-shop",
  projectsDir: "projects",
  serverProject: "api",
  branches: { base: "main", prefix: "feature/" },
  defaults: { plugin: "@apartx/wt/plugin-node" },
  projects: {
    api: { core: { slug: "base" } },
    storefront: {},
    admin: {},
  },
  links: ["storefront:api:env:API_URL", "admin:api:env:API_URL"],
});
```

The workspace needs no `node_modules`: the installed `wt` resolves the `@apartx/wt` import to
itself. Then, from anywhere inside `my-shop/`:

```bash
wt projects                            # admin, api, storefront
wt new api my-feature                  # worktrees/api/my-feature on branch feature/my-feature, PORT=3010
wt new storefront my-feature           # worktrees/storefront/my-feature, PORT=3120
wt start api my-feature                # background instance on :3010
wt start storefront my-feature --link  # on :3120, with API_URL=http://localhost:3010
wt ps                                  # what runs, on which port
wt ui                                  # full-screen terminal dashboard
wt web                                 # web dashboard on http://127.0.0.1:4499
wt down                                # stop everything
```

`--link` repoints all upstreams of the storefront (the `links` that name it as the consumer) at
the same-slug worktrees, so the feature branch of the storefront talks to the feature branch of
the API while `main` keeps talking to `main`. `--server` does the same for the `serverProject`
upstream only. A worktree's port is its project's base port plus an offset; offsets are unique
across the workspace, recorded in `var/worktree-ports.tsv`, and stay reserved after `wt rm`, so
a branch gets the same port every time.

Add `var/` and `worktrees/` to the workspace's `.gitignore` if the workspace itself is a git
repository — that is where `wt` keeps its state and the worktrees.

## Commands

`<p>` is a project (a directory under `projectsDir`). Without a slug a command acts on the base
checkout `projects/<p>` (slug `base`). In a single-repo workspace `<p>` is implied and omitted:
`wt new <slug>`, `wt start [slug]`.

| Command | Description |
|---------|-------------|
| `wt new <p> <slug> [--isolated-db [--seed]]` | create worktree + branch + install + env |
| `wt run <p> [slug] [--link\|--server [slug]]` | run in the foreground (Ctrl-C, host projects only) |
| `wt start <p> [slug] [--link\|--server [slug]]` | run in the background (host: pidfile + log / dockerized: container) |
| `wt stop <p> [slug] \| --all` | stop an instance / all of them |
| `wt restart <p> [slug]` | stop + start |
| `wt up` | start the core stack (projects with `core` in `wt.config.ts`) |
| `wt down` | stop every running instance |
| `wt ps [--json]` | running instances |
| `wt list [--json]` | existing worktrees |
| `wt logs <p> [slug] [-f] \| --all` | logs of background instance(s) |
| `wt link <p> <slug> [slug]` | point the project at its upstreams' worktrees (`links` in `wt.config.ts`) |
| `wt unlink <p> <slug>` | restore `settings.json`/`.env` from the repository |
| `wt rm <p> <slug> [--branch]` | remove a worktree (+ optionally its branch) |
| `wt reap` | remove all `wtdev-*` dev containers |
| `wt sweep [--apply] [--json]` | remove worktrees whose branches are merged (GitLab merge requests via `glab`; without `--apply` = plan) |
| `wt slim [--apply] [--json]` | remove restorable artifacts (dependencies, build caches, docker volumes) in all stopped worktrees + orphan volumes (without `--apply` = plan) |
| `wt port <p> [slug] [--json]` | print the allocated port |
| `wt projects [--json]` | list projects |
| `wt ui` | full-screen TUI dashboard |
| `wt web [--dev]` | web dashboard (built static; `--dev` runs vite dev) |
| `wt version \| --version` | wt version |

The optional slug after `--link`/`--server` links to the upstreams' worktrees of a *different*
slug. Most commands also accept `--json`. `WT_DEBUG=1` prints the stack trace of an error.

## Dashboards

`wt ui` is a full-screen terminal dashboard: the worktrees and base checkouts of the workspace
with live status, and keys to start, stop, restart, link, unlink, create and remove worktrees and to
tail logs. `wt web` shows the same live instance list in the browser.

Both talk to a small HTTP daemon, the wt-server, on `127.0.0.1` (`WT_SERVER_HOST`) port
`WT_SERVER_PORT` (default `4499`), which also serves the prebuilt web dashboard; `wt web` prints its URL and keeps running until Ctrl-C.
`wt web --dev` runs the dashboard's vite dev server on `WT_WEB_PORT` (default `5199`) instead;
it needs a source checkout of `wt` (the `web/` sources are not in the npm package).

**How the dashboard daemon works.** There is one daemon per port, and it is bound to one
workspace. `wt ui`/`wt web` reuse a running daemon only if it speaks the current protocol,
drives the same workspace and serves the dashboard; otherwise they replace it. So a `wt ui` or
`wt web` started in another workspace takes over the port, and a dashboard still open for the
first workspace starts showing the second one. To watch two workspaces at once, give one of
them another port: `WT_SERVER_PORT=4498 wt ui`. The daemon lives as long as the `wt ui`/`wt web`
that started it.

## Configuration

- [docs/config.md](docs/config.md) — the `wt.config.ts` reference: every field, single-repo vs
  multi-repo, `links`, `env` templates, editor types and the JSON schema.
- [docs/plugins.md](docs/plugins.md) — the `StackPlugin` contract, the bundled Node, Meteor and
  Rust plugins, env layering and the `.env.worktree` lifecycle.
- [docs/agents.md](docs/agents.md) — for coding agents: a checklist to set up a workspace, and a
  block to paste into the workspace's `AGENTS.md` / `CLAUDE.md` so later sessions use `wt`
  instead of hand-made worktrees and ports. [AGENTS.md](AGENTS.md) is for working on `wt` itself.

Plugin ids are package specifiers: `"@apartx/wt/plugin-node"`, `"@apartx/wt/plugin-meteor"` and
`"@apartx/wt/plugin-rust"`.
**Migrating from the pre-release ids:** `"@wt/plugin-node"` and `"@wt/plugin-meteor"` are no
longer accepted — `wt` stops with a `renamed to …` error before it creates anything (no
worktree or branch is left behind); replace them in `wt.config.ts`.

## Development

```bash
git clone https://github.com/apartx-ltd/wt && cd wt
bun install        # also fetches the web dashboard's UI kit from GitHub (needs network + git)
bun link           # the global `wt` now runs this checkout — TypeScript directly, no build step
```

Edits take effect on the next `wt` invocation; there is nothing to reinstall.

```bash
bun test               # unit and integration tests
bun run typecheck      # tsc --noEmit
bun run e2e            # TUI end-to-end flows
bun run build:web      # build the web dashboard into web/build (served by `wt web`)
wt web --dev           # web dashboard with hot reload (vite dev server)
```

The dashboard's UI kit (`apartx-ui`) is a git `devDependency` of `web/`, pinned to a commit, so
`bun install` in a checkout needs network access to GitHub. The published package does not
depend on it: `web/build` ships prebuilt in the tarball (`prepack` runs `build:web`).

## Limitations

- **Bun only.** The CLI, the TUI and the server run on Bun; Node is not supported.
- **`wt sweep` is GitLab-only.** It checks merge requests on gitlab.com through the `glab` CLI;
  GitHub pull requests are not supported yet.
- **Docker mode is macOS-only for now.** A container reaches services on the host by the
  machine's mDNS name (`<LocalHostName>.local`), which `wt` reads with macOS's `scutil`; without
  `scutil` it falls back to `host.docker.internal`, but docker mode on Linux is untested and not
  expected to work yet. Replacing a dashboard daemon finds the
  process on the port with `lsof`.
- **No third-party plugins yet.** The plugin registry knows only the bundled plugins; loading a
  plugin from another package is planned.
- **The wt-server has no authentication.** It can start and stop instances and remove
  worktrees, so it binds `127.0.0.1` by default and rejects state-changing requests whose
  `Origin` is not a loopback address (a web page on another site cannot drive it through your
  browser). `WT_SERVER_HOST=0.0.0.0` opts into exposing it on the LAN — still with no
  authentication, so anyone who can reach the port controls your worktrees; do that only on a
  trusted network. In that mode the dashboard's own same-origin requests are also accepted when
  it is opened by an IP address (`http://192.168.1.5:4499`) or by the `WT_SERVER_HOST` name, but
  not by any other host name — that would let a DNS-rebinding page pass as same-origin.

## License

[MIT](LICENSE)
