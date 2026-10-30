import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { packageRoot } from "./orch";

let registered = false;

/**
 * A globally installed wt loads the consumer's `wt.config.ts`, and that workspace has no
 * `node_modules`, so a bare `import … from "@apartx/wt"` there does not resolve. This registers
 * Bun runtime virtual modules for `@apartx/wt` and its subpaths from the `exports` map of the
 * root `package.json` (read at runtime, so the resolver cannot drift from `exports`). Each one
 * exposes the namespace of the package's real file: the same module instance, loaded lazily on
 * first import. It also overrides an `@apartx/wt` in the consumer's `node_modules`, so the
 * config sees the wt version that executes it. An unknown subpath gets Bun's standard
 * "Cannot find module" error.
 *
 * It uses `build.module`, not `build.onResolve`, because in Bun 1.3 a runtime `onResolve` hook
 * is not called for bare specifiers that are missing from `node_modules`.
 * Idempotent: registers once per process.
 */
export function registerSelfResolver(root = packageRoot()): void {
  if (registered) return;
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
    name: string;
    exports: Record<string, unknown>;
  };
  const entries = Object.entries(pkg.exports).map(([subpath, file]) => {
    if (typeof file !== "string") {
      throw new Error(`wt: unsupported exports entry "${subpath}" in ${resolve(root, "package.json")} (only string targets are supported)`);
    }
    return [pkg.name + subpath.slice(1), resolve(root, file)] as const;
  });
  Bun.plugin({
    name: "@apartx/wt self-resolve",
    setup(build) {
      for (const [specifier, target] of entries) {
        build.module(specifier, () => ({ exports: moduleExports(target), loader: "object" }));
      }
    },
  });
  registered = true;
}

/**
 * Exports of a package file for an object-loader virtual module. An ESM namespace is passed as
 * is (real named exports and `default`, if any). A JSON file mirrors a native JSON import: the
 * whole object as `default`, plus its top-level keys as named exports.
 */
function moduleExports(target: string): Record<string, unknown> {
  const mod = require(target);
  return target.endsWith(".json") ? { ...mod, default: mod } : mod;
}
