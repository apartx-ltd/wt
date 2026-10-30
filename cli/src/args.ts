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
