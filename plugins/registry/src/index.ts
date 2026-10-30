import { registerPlugin } from "#core/plugin";
import { meteorPlugin } from "#plugin-meteor";
import { nodePlugin } from "#plugin-node";

/** Зарегистрировать все бандл-плагины. Вызывать один раз при старте процесса (из энтрипойнтов). */
export function registerBundledPlugins(): void {
  registerPlugin("@wt/plugin-meteor", meteorPlugin);
  registerPlugin("@wt/plugin-node", nodePlugin);
}
