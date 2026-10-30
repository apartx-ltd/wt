/**
 * Resolve the project argument from a command's positional arguments.
 * Multi-repo: the first positional is the project name, the rest shift down.
 * Single-repo: the project is implicit (the only one in the workspace), positionals do not shift.
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
