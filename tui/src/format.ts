import type { RunStatus } from "#shared";

export function statusDot(status: RunStatus): { glyph: string; fg: string } {
  switch (status) {
    case "up": return { glyph: "●", fg: "#3fb950" };
    case "building": return { glyph: "◍", fg: "#d29922" };
    case "down": return { glyph: "○", fg: "#6e7681" };
  }
}

export function uptime(started: number | null, now: number): string {
  if (started == null) return "";
  const s = Math.max(0, now - started);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}
