import type { StopOutcome } from "#core";

/**
 * The `wt stop` report line, based on what ACTUALLY happened, not on the planned action:
 * with a non-empty error the instance is still alive, and the word "stopped" must not appear in the output.
 */
export function stopLine(project: string, slug: string, r: StopOutcome): { ok: boolean; text: string } {
  if (r.error) return { ok: false, text: `failed to stop ${project}/${slug}: ${r.error}` };
  if (r.action === "container") return { ok: true, text: `stopped ${project}/${slug} (container ${r.container})` };
  if (r.action === "pid") return { ok: true, text: `stopped ${project}/${slug} (PID ${r.pid})` };
  return { ok: true, text: `${project}/${slug} was no longer alive — cleaned up the runfile` };
}

/** printf `%-<w>s`: pad with spaces on the right up to the width, no truncation. */
export function col(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

/** Parity with fmt_uptime(): s<60→Ns, <3600→Mm, otherwise HhMm. Negative→0s. */
export function fmtUptime(started: number, now: number): string {
  let s = now - started;
  if (s < 0) s = 0;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}
