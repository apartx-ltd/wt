import type { MergedInstance } from "#shared";

/** Identity ignores volatile fields (uptime derives from `started`, which is stable). */
function signature(list: MergedInstance[]): string {
  return JSON.stringify(
    list.map((i) => [i.project, i.slug, i.branch, i.port, i.status, i.pid, i.container, i.started]),
  );
}

export function instancesChanged(prev: MergedInstance[], next: MergedInstance[]): boolean {
  return signature(prev) !== signature(next);
}
