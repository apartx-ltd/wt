# History

## Unreleased

- Plugin contract: optional `upTimeoutMs` lets a plugin say how long `wt start` waits for the
  instance port before reporting `did NOT come up in time`. Without it the core keeps its
  10-minute wait.
- New bundled plugin `@apartx/wt/plugin-rust` for cargo projects: `cargo fetch` / `cargo run`
  (or the project's `dev` cargo alias), the port reaches the binary through `PORT` only,
  `target/` is the restorable artifact; docker layout with a `target` volume per worktree and
  shared cargo caches.
- Plugin contract: optional `deps: { dir, files }` lets a plugin declare where its dependencies
  live and which files fingerprint them. The core's install/staleness check, stamp and docker
  deps volume follow it; without it the node layout (`node_modules`, npm files) is used as
  before, so existing plugins and volumes are unchanged.
- `wt rm` removes the volumes the project's plugin declares as its own (`docker().ownedVolumes`)
  instead of the fixed node_modules/meteor_local pair.

## 0.1.0 — 2026-10-30

First public release. Extracted from the apartx orchestrator (`tools/wt`, 2026-06 → 2026-10).

- Git worktrees per branch (`wt new`, `wt rm`) with deterministic, collision-free ports kept in a
  workspace port ledger.
- Per-worktree env: a generated `.env.worktree` layered over the project's `.env`, self-healing
  on every start while preserving hand-added keys.
- Links mesh: `--link` / `--server` / `wt link` point a service at the same-branch worktrees of
  its upstreams through env or settings overlays.
- Host-process and Docker-container instances (`wt start`, `run`, `stop`, `restart`, `up`,
  `down`, `logs`, `reap`), configured per project in `wt.config.ts`.
- Isolated per-branch databases (`wt new --isolated-db [--seed]`).
- Disk housekeeping: `wt sweep` removes worktrees of merged branches, `wt slim` removes
  restorable dependencies and volumes of stopped worktrees.
- Full-screen terminal dashboard (`wt ui`) and a web dashboard (`wt web`) backed by a local
  wt-server that binds `127.0.0.1` by default and rejects cross-origin writes
  (`WT_SERVER_HOST` opts into LAN exposure).
- Bundled stack plugins `@apartx/wt/plugin-node` and `@apartx/wt/plugin-meteor`; single-repo
  and multi-repo workspaces; `wt.config.ts` loads without `node_modules` in the workspace.
