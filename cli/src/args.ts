/**
 * Разрешить аргумент проекта из позиционных аргументов команды.
 * Multi-repo: первый позиционный — имя проекта, остальные сдвигаются вниз.
 * Single-repo: проект неявный (единственный в workspace), позиционные не сдвигаются.
 */
export function resolveProjectArg(
  positional: string[],
  ctx: { singleRepo: boolean; soleProject?: string },
): { project: string | undefined; pos: string[] } {
  if (ctx.singleRepo) return { project: ctx.soleProject, pos: positional };
  return { project: positional[0], pos: positional.slice(1) };
}

/** `wt web [--dev]`: `--dev` runs the vite dev server instead of the built static dashboard. */
export function parseWebArgs(args: string[]): { dev: boolean } {
  if (args.some((a) => a !== "--dev")) throw new Error("usage: wt web [--dev]");
  return { dev: args.includes("--dev") };
}
