import type { StopOutcome } from "#core";

/**
 * Строка отчёта `wt stop` по ФАКТУ остановки, а не по запланированному действию:
 * при непустом error инстанс остался жив, и слова «stopped» в выводе быть не должно.
 */
export function stopLine(project: string, slug: string, r: StopOutcome): { ok: boolean; text: string } {
  if (r.error) return { ok: false, text: `не удалось остановить ${project}/${slug}: ${r.error}` };
  if (r.action === "container") return { ok: true, text: `stopped ${project}/${slug} (контейнер ${r.container})` };
  if (r.action === "pid") return { ok: true, text: `stopped ${project}/${slug} (PID ${r.pid})` };
  return { ok: true, text: `${project}/${slug} уже не жив — почистил runfile` };
}

/** printf `%-<w>s`: дополнить пробелами справа до ширины, без обрезки. */
export function col(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

/** Паритет с fmt_uptime(): s<60→Ns, <3600→Mm, иначе HhMm. Отрицательное→0s. */
export function fmtUptime(started: number, now: number): string {
  let s = now - started;
  if (s < 0) s = 0;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}
