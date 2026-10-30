# wt for coding agents

This page is for an AI coding agent (Claude Code, Codex, Cursor, Aider, …) that is asked to
set up `wt` in a workspace, or that works in a workspace which already uses it. Humans are
welcome too, but the wording assumes you act on instructions and need to know what is safe.

It has two parts:

1. [Setting up a workspace](#part-1-setting-up-a-workspace) — a checklist to go from "three
   repos and an idea" to a working `wt.config.ts`, with a smoke test.
2. [The `AGENTS.md` block](#part-2-the-agentsmd-block) — a section to paste into the workspace's
   `AGENTS.md` / `CLAUDE.md` so that every later session uses `wt` instead of inventing its own
   worktrees, ports and env files.

The command reference is in the [README](../README.md); every config field is in
[config.md](config.md); the plugin contract is in [plugins.md](plugins.md).

## Part 1: Setting up a workspace

### Step 0 — check the tool

```bash
wt --version
```

If it is missing: `bun install -g @apartx/wt` (Bun 1.3 or newer; `~/.bun/bin` must be on `PATH`).
Do not install Bun on the user's machine without telling them — say what you need and why.

### Step 1 — pick the workspace shape

- **Multi-repo**: a workspace directory (the "orchestrator") with one git repository per service
  under `projects/`. Use this when the API, the storefront and the admin panel are separate
  repositories. The workspace directory may itself be a git repository (for docs, scripts and
  `wt.config.ts`) — then `projects/` entries are usually git submodules or plain clones listed in
  its `.gitignore`.
- **Single-repo**: the repository itself is the workspace; `wt.config.ts` sits at its root and
  the one project is implied in every command (`wt new my-feature`).

```
my-shop/                      multi-repo workspace
├── wt.config.ts
├── .gitignore                var/ and worktrees/ (and projects/ if they are plain clones)
└── projects/
    ├── api/                  git repo
    ├── storefront/           git repo
    └── admin/                git repo
```

### Step 2 — collect the facts `wt` needs from each project

Open each project's base checkout and find:

| Fact | Where to look | Why `wt` needs it |
|------|---------------|-------------------|
| **Base port** | `PORT=` in `.env`, or `--port NN` / `-p NN` / `PORT=NN` in the `dev` script of `package.json` | Worktree ports are the base port plus an offset (`3000` → `3010`, `3020`, …). No base port → `wt new` fails with `no PORT found`. |
| **Dev script honors `--port`** | `package.json` `scripts.dev` | The Node plugin starts an instance with `npm run dev -- --port <port>`. Vite, Next, SvelteKit, Nuxt and Astro accept it; a custom script may need `process.env.PORT` or a `--port` flag. Fix the script, not `wt`. |
| **Stack** | `package.json`, `.meteor/` | `plugin: "@apartx/wt/plugin-node"` or `"@apartx/wt/plugin-meteor"`. Anything else is not supported yet — say so instead of guessing. |
| **Upstream URLs** | env keys such as `API_URL`, `SERVER_URL`, `VITE_API_URL` in `.env` | These become `links` so that a feature branch of the storefront talks to the feature branch of the API. The key must exist in the base `.env` with its current value. |
| **Docker** | the project only runs inside a container (native deps, OS-specific toolchain) | `docker: { image }` runs the instance in a container instead of a host process. Docker mode is macOS-only for now, see the README's Limitations. |
| **Database** | `MONGO_URL`, `DATABASE_URL` | Only relevant if branches change the schema: the Meteor plugin supports `wt new --isolated-db [--seed]`. Default is the shared dev database — do not isolate by default. |

### Step 3 — write `wt.config.ts`

Multi-repo example for the layout above (an API that the other two call):

```ts
import { defineWorkspace } from "@apartx/wt";

export default defineWorkspace({
  title: "my-shop",
  projectsDir: "projects",
  serverProject: "api",
  branches: { base: "main", prefix: "feature/" },
  defaults: { plugin: "@apartx/wt/plugin-node" },
  projects: {
    api: { core: { slug: "base" } },   // `wt up` starts the base checkout of the API
    storefront: {},
    admin: {},
  },
  links: ["storefront:api:env:API_URL", "admin:api:env:API_URL"],
});
```

Single-repo:

```ts
import { defineWorkspace } from "@apartx/wt";

export default defineWorkspace({
  project: { plugin: "@apartx/wt/plugin-node" },
  branches: { base: "main", prefix: "feature/" },
});
```

Rules of thumb:

- `branches.base` is the branch a new worktree forks from — `main` or `develop`, whatever the
  team merges into. `branches.prefix` plus the slug is the branch name.
- Put the plugin in `defaults` and list every project, even with an empty `{}`: an unlisted
  repository under `projects/` is configured by `defaults` alone, which is fine, but listing it
  documents the workspace.
- A link is `<consumer>:<upstream>:env:<KEY>` (rewrites `KEY` in the consumer's env) or
  `<consumer>:<upstream>:settings:<path>` (patches a JSON settings file). See
  [config.md → Links](config.md#links).
- The workspace needs no `node_modules`: the installed `wt` resolves the `@apartx/wt` import to
  itself. For editor type checking of `wt.config.ts` add `bun add -d @apartx/wt @types/bun`.

Verify the file loads and the projects are seen:

```bash
wt projects          # lists every repository under projects/
```

A typo in a field name or a wrong plugin id fails here with `wt: wt.config: …`, exit code 1.

### Step 4 — git hygiene

Add to the workspace's `.gitignore` (multi-repo: the orchestrator's; single-repo: the
repository's):

```
var/
worktrees/
```

`wt new` adds `.env.worktree` to each project's `.git/info/exclude`, so the generated env file
never shows up in `git status`. Nothing under `var/` is meant to be committed — it is the port
ledger, run files, logs and link overlays of this machine.

### Step 5 — smoke test

Run the whole lifecycle once on a throwaway slug, from anywhere inside the workspace:

```bash
wt new api smoke            # worktrees/api/smoke on branch feature/smoke, dependencies installed
wt port api smoke           # the allocated port, e.g. 3010
wt start api smoke          # background instance
wt ps                       # it is listed with its port and PID / container
wt logs api smoke           # its log (var/run/api-smoke.log)
wt stop api smoke
wt rm api smoke --branch    # remove the worktree and the local branch
```

If a service calls another one, test the link too: `wt new storefront smoke`, then
`wt start storefront smoke --link` and check `var/env/storefront-smoke.env` — it must contain
`API_URL=http://localhost:<api smoke port>`.

The port of `feature/smoke` stays reserved in `var/worktree-ports.tsv` after `wt rm`; that is by
design (a branch keeps its port forever).

### Step 6 — leave instructions for the next session

Paste the block from Part 2 into the workspace's `AGENTS.md` (or `CLAUDE.md`), replacing the
placeholders. Without it, the next agent session will reach for `git worktree add` and a
hand-picked port, and the ledger drifts.

### What not to do

- Never run `git worktree add` / `git worktree remove` by hand in a `wt` workspace — the port
  ledger and the run files would not know about the worktree.
- Never pick a port or edit `.env.worktree`, `var/env/*` or `var/settings/*` by hand — `wt`
  rewrites its managed keys on every start (custom keys in `.env.worktree` are preserved).
- Never commit `var/` or `worktrees/`.
- Never put secrets in `wt.config.ts` — it is committed; `.env` files are the place.

## Part 2: The `AGENTS.md` block

Copy everything between the rules into the workspace's `AGENTS.md` / `CLAUDE.md` and replace the
`<…>` placeholders. Keep it short: the agent needs the rules and the commands, not the manual.

---

````markdown
## Worktrees and dev instances (`wt`)

This workspace uses [`wt`](https://github.com/apartx-ltd/wt) for git worktrees, ports, per-worktree
env and dev instances. **Always use `wt`; never run `git worktree add`, pick a port, or edit
`.env.worktree` by hand** — `wt` allocates ports deterministically per branch and rewrites the
env it manages on every start.

Projects: `<api>`, `<storefront>`, `<admin>` (under `projects/`). `<storefront>` and `<admin>`
call `<api>` through `<API_URL>`.

```bash
wt new   <p> <slug>            # worktree + branch <prefix><slug> from <base> + install + env
wt start <p> <slug>            # background instance (wt run … = foreground, Ctrl-C)
wt start <p> <slug> --link     # also point it at the same-slug worktrees of its upstreams
wt ps                          # what runs where; wt list = existing worktrees
wt logs  <p> <slug> -f         # tail an instance's log
wt port  <p> <slug>            # the port of an existing worktree
wt stop  <p> <slug>            # stop one; wt down = stop everything
wt rm    <p> <slug> [--branch] # remove the worktree (and the local branch)
```

Rules:

- **Start isolated work with `wt new <p> <slug>`** (one slug per task; the same slug across
  projects for a cross-service change). Work and run tests inside `worktrees/<p>/<slug>`.
- **Cross-service branches start with `--link`**, otherwise the worktree talks to the base
  instances on the default ports and end-to-end checks are meaningless.
- **Ports come from `wt port`**, never from a guess. Base checkouts (`projects/<p>`) run on
  their `.env` port via `wt start <p>` (no slug).
- **Database**: the shared dev database by default. Pass `--isolated-db [--seed]` to `wt new`
  only when the branch changes the schema or runs migrations.
- **Finish**: commit and push the branch, then `wt stop <p> <slug>` and `wt rm <p> <slug>`.
  The port stays reserved for the branch.
- `var/` and `worktrees/` are local state — never commit them. Logs are `var/run/<p>-<slug>.log`.
- Outside the workspace `wt` says `no wt.config.ts found`; run it from inside, or set
  `WT_ORCH=<workspace dir>`. `WT_DEBUG=1` prints stack traces. `--json` is available on `ps`,
  `list`, `port`, `projects` for machine-readable output.
````

---

If the team uses a different base branch, Docker mode, or Meteor, add one line each:
`branches.base` (`develop`), "`<p>` runs as a Docker container — `wt start` builds nothing, the
image is `<image>`", "`<p>` is Meteor — `wt new` runs `meteor npm install`". Keep the rules
section as it is; it is the part agents skip when it grows.
