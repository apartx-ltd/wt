# `wt.config.ts` reference

A workspace is the directory that holds `wt.config.ts`. `wt` finds it by walking up from the
current directory (or takes it from `WT_ORCH`), loads the file with Bun and validates it. The
file default-exports a `WorkspaceConfig`, usually wrapped in `defineWorkspace` for typing:

```ts
import { defineWorkspace } from "@apartx/wt";

export default defineWorkspace({
  // …
});
```

The source of truth for the shape is `core/src/config.ts`.

## Workspace layout

```
<workspace>/
├── wt.config.ts
├── projects/<p>/              base checkouts — one git repo per project (slug "base")
├── worktrees/<p>/<slug>/      worktrees created by `wt new`, on branch <prefix><slug>
└── var/
    ├── worktree-ports.tsv     port ledger: project, branch, offset
    ├── run/                   runfiles, logs, rendered env and settings of instances
    ├── env/<p>-<slug>.env     env overlays written by links
    └── settings/<p>-<slug>.json  settings overlays written by links
```

`var/` and `worktrees/` are created on demand. If the workspace is itself a git repository, add
both to its `.gitignore`. `wt new` adds `.env.worktree` to the project's `.git/info/exclude`.

## Multi-repo and single-repo

**Multi-repo** — several repositories under `projectsDir`, described in `projects`:

```ts
export default defineWorkspace({
  projectsDir: "projects",
  defaults: { plugin: "@apartx/wt/plugin-node" },
  projects: { api: {}, storefront: {}, admin: {} },
});
```

The first positional argument of most commands is the project: `wt new api my-feature`.

**Single-repo** — the workspace is the repository itself, described in `project`:

```ts
export default defineWorkspace({
  project: { plugin: "@apartx/wt/plugin-node" },
  branches: { base: "main", prefix: "feature/" },
});
```

The project is named after the repository's directory and is implied in every command:
`wt new my-feature`, `wt start my-feature`, `wt port`. Worktrees go to
`<repo>/worktrees/<repo-name>/<slug>` and state to `<repo>/var/` — add both to the repository's
`.gitignore`.

Exactly one of `project` / `projects` must be set, and `projectsDir` cannot be combined with
`project`; otherwise loading the config fails with a `wt.config: …` error.

## `WorkspaceConfig`

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `title` | `string` | — | Workspace name shown by the dashboards as `wt · <title>` (`wt · worktrees` when unset). |
| `serverProject` | `string` | — | The upstream that `--server` links to (`wt start <p> <slug> --server`). `--server` fails when it is unset. |
| `projectsDir` | `string` | `"projects"` | Multi-repo: the directory holding the repositories. Every subdirectory with a `.git` is a project. |
| `project` | `ProjectConfig` | — | Single-repo: the one project (the workspace root). |
| `projects` | `Record<string, ProjectConfig>` | — | Multi-repo: projects keyed by their directory name under `projectsDir`. |
| `branches` | `{ base: string; prefix: string }` | `{ base: "main", prefix: "feature/" }` | `wt new <p> <slug>` creates branch `<prefix><slug>` from `base` in the project repository (or checks out `<prefix><slug>` if it already exists locally). |
| `ports` | `{ step?: number }` | `{ step: 10 }` | `step`: the distance between worktree port offsets, see [Ports](#ports). Must be a positive integer; no other range checks are made. |
| `defaults` | `ProjectConfig` | `{}` | Deep-merged into every entry of `projects` / `project`: nested objects merge, scalars and arrays are replaced by the project's value. |
| `links` | `string[]` | `[]` | Inter-service links, see [Links](#links). |

**Unlisted projects.** A repository under `projectsDir` that is missing from `projects` is still
a project (`wt projects`, `wt list`, `wt new` see it) and is configured by `defaults` alone, as if
it were listed with an empty entry `{}`. If `defaults.plugin` is unset, commands that need its
config (`wt new`, `wt start`, …) fail with `wt.config: project "<p>" is not listed and
defaults.plugin is unset` — list the project or set `defaults.plugin`.

## `ProjectConfig`

| Field | Type | Meaning |
|-------|------|---------|
| `plugin` | `string` | The stack plugin: `"@apartx/wt/plugin-node"` or `"@apartx/wt/plugin-meteor"` (see [plugins.md](plugins.md)). Falls back to `defaults.plugin`; a project with no plugin at all fails validation. |
| `docker` | `{ image: string }` | Present ⇒ the project runs in Docker (container `wtdev-<p>-<slug>`, base checkout included); `image` is the dev image and must contain the stack's toolchain. `wt new` runs the install inside the image too. Absent ⇒ host process. |
| `core` | `{ slug: string }` | Present ⇒ the project belongs to the core stack: `wt up` starts `<p>/<slug>` (use `"base"` for the base checkout). |
| `env` | `Record<string, string>` | Extra keys written to the worktree's `.env.worktree`, with templates (below). The base checkout does not get them. |

### `env` templates

Values may contain:

| Placeholder | Value |
|-------------|-------|
| `${port}` | The worktree's port (base port + offset). |
| `${offset}` | The worktree's port offset (`10`, `20`, …). |
| `${branchSuffix}` | The branch without its `type/` prefix, non-alphanumerics replaced by `_` (`feature/my-feature` → `my_feature`). |

Unknown placeholders are left as is. The keys are wt-managed: they are rewritten on every
`wt start` (see the `.env.worktree` lifecycle in [plugins.md](plugins.md)). Typical use is to
namespace shared resources per branch:

```ts
projects: {
  api: { env: { QUEUE_PREFIX: "api_${branchSuffix}", PUBLIC_URL: "http://localhost:${port}" } },
},
```

## Ports

A project's **base port** is the first `PORT=` in `projects/<p>/.env`, otherwise the first
`PORT=NN`, `--port NN`, `--port=NN` or `-p NN` in its `package.json`. A project with neither
cannot get a worktree (`wt new` fails with `no PORT found …`).

A **worktree's port** is the base port plus an offset. The offset is the smallest multiple of
`ports.step` (default 10) not used by any branch of any project in `var/worktree-ports.tsv`, so
the same slug gets different offsets in different projects, and a branch keeps its offset for
good — including after `wt rm`. The ledger records absolute offsets, so changing `ports.step`
affects only branches allocated afterwards. Ports 5000 and 7000 are never handed out (taken by
macOS system services). `wt port <p> <slug>` prints the port of an existing worktree; `wt port
<p>` prints the base port.

Keep the step at 10 or more if a plugin allocates extra ports (such as the Meteor plugin's HMR
port, see `extraPorts` in [plugins.md](plugins.md)): the base checkouts of the dockerized
projects take up to 10 consecutive extra ports, and a worktree's extra ports are shifted by the
same offset as its `PORT`, so a smaller step can make them collide.

## Links

A link says "this consumer talks to that target". Format: `consumer:target:mechanism:key`.

```ts
links: [
  "storefront:api:env:API_URL",              // env mechanism: a key in .env
  "admin:api:settings:public.apiUrl",        // settings mechanism: a dotted path in settings.json
],
```

Linking `<consumer>/<slug>` reads the port of the target's worktree with the same slug (or the
slug given after `--link`/`--server`/`wt link <p> <slug> <link-slug>`) and writes an overlay:

- **`env`** — takes the value of `key` from the consumer's base `.env`, replaces its port
  (`:NNNN` followed by `/` or the end) with the target's port and writes `key=value` to
  `var/env/<consumer>-<slug>.env`. The overlay takes precedence over `.env.worktree` and `.env`.
  If the consumer's `.env` lacks the key, the link is skipped.
- **`settings`** — takes the consumer worktree's `settings/settings.json` (or `settings.json`),
  replaces the port in the value at the dotted path `key` and writes the result to
  `var/settings/<consumer>-<slug>.json`, which is passed to the dev command as its settings file
  (used by the Meteor plugin's `--settings`).

A link whose target has no worktree for that slug is skipped. Links are applied by
`wt start|run|restart … --link` (all upstreams), `… --server` (the `serverProject` upstream only)
and `wt link` (all upstreams; restart the instance to apply). The overlays stay until
`wt unlink <p> <slug>`, so a later plain `wt start` keeps the link.

## Editor types and JSON schema

`wt` does not need anything installed in the workspace — the `@apartx/wt` import in
`wt.config.ts` is resolved by the running `wt` itself. For type checking and completion in an
editor, add the package as a dev dependency of the workspace (optional, the runtime ignores it):

```bash
bun add -d @apartx/wt
```

`@apartx/wt` exports `defineWorkspace` and the types `WorkspaceConfig`, `ProjectConfig`,
`BranchConfig`, `PortsConfig`, `DockerConfig` and `CoreSpec`.

For tools that cannot read TypeScript types, a draft-07 JSON Schema of the config is exported as
`@apartx/wt/config-schema` (file `core/schema/wt.config.schema.json` in the package).
