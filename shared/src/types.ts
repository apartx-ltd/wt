/**
 * HTTP contract version. Bump whenever the server's routes/wire format change so a
 * client can detect (via GET /api/health) that a server still listening on the port
 * is from an older build and must be replaced — otherwise a stale server gets reused
 * and newer routes 404 (this is how the log pane silently broke after P2 added /logs).
 *
 * v3: server read paths (instances/projects/events) moved from spawning `./scripts/wt
 * … --json` to calling `@wt/core` in-process. Wire format is unchanged, but the bump
 * forces any server lingering from a pre-convergence build to be replaced.
 *
 * v4: spawned `wt` subprocesses no longer inherit the daemon's `PORT` (it leaked into
 * host-process starts → "Can't listen on port 4499"). Behaviour-only, but the bump
 * replaces stale v3 servers so the fix actually takes effect on the next `wt tui`/`web`.
 */
export const WT_PROTOCOL_VERSION = 4;

export type RunStatus = "up" | "down" | "building";

/** Row from `wt list --json` — an existing worktree on disk. */
export interface Worktree {
  project: string;
  /** worktree directory name — the operational slug start/stop/port/rm resolve by. */
  slug: string;
  branch: string;
  port: number | null;
  path: string;
}

/** Row from `wt ps --json` — a running instance. */
export interface RunInstance {
  project: string;
  slug: string;
  branch: string;
  port: number | null;
  pid: number | null;
  container: string | null;
  started: number; // epoch seconds
  alive: boolean;
}

/** What the dashboard renders: a worktree (or bare running instance) + its live status. */
export interface MergedInstance {
  project: string;
  slug: string;
  branch: string;
  port: number | null;
  status: RunStatus;
  pid: number | null;
  container: string | null;
  started: number | null;
}

/** Per-project base-checkout descriptor for seeding synthetic `base` rows. */
export interface BaseSpec {
  project: string;
  /** branch currently checked out in the base checkout (projects/<p>). */
  branch: string;
  /** base PORT (worktree offset 0); null if no base .env yet. */
  port: number | null;
}

/** SSE event payloads on /api/events. */
export type WtEvent =
  | { type: "instances"; instances: MergedInstance[] }
  | { type: "error"; message: string };

/** Метаданные workspace, отдаваемые сервером фронтендам (заголовок и т.п.). */
export interface WtMeta {
  /** config.title; null если не задан в wt.config. */
  title: string | null;
}
