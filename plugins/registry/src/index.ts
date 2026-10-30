import { registerPlugin } from "@wt/core/plugin";
import { meteorPlugin } from "@wt/plugin-meteor";
import { nodePlugin } from "@wt/plugin-node";

/** Зарегистрировать все бандл-плагины. Вызывать один раз при старте процесса (из энтрипойнтов). */
export function registerBundledPlugins(): void {
  registerPlugin("@wt/plugin-meteor", meteorPlugin);
  registerPlugin("@wt/plugin-node", nodePlugin);
}
