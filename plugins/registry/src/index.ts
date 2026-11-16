import { registerPlugin } from "#core/plugin";
import { meteorPlugin } from "#plugin-meteor";
import { nodePlugin } from "#plugin-node";
import { pnpmPlugin } from "#plugin-pnpm";
import { rustPlugin } from "#plugin-rust";

/** Register all bundled plugins. Call once at process start (from the entry points). */
export function registerBundledPlugins(): void {
  registerPlugin("@apartx/wt/plugin-meteor", meteorPlugin);
  registerPlugin("@apartx/wt/plugin-node", nodePlugin);
  registerPlugin("@apartx/wt/plugin-pnpm", pnpmPlugin);
  registerPlugin("@apartx/wt/plugin-rust", rustPlugin);
}
