import type { ResolvedProjectConfig } from "./config";

/**
 * Version of the StackPlugin↔core contract. Bump it on an incompatible interface change
 * (a new required field / changed ctx semantics). loadPlugin rejects a plugin with a different
 * version: as OSS, a core update must not silently break a third-party plugin.
 */
export const PLUGIN_API_VERSION = 1;

/** A command the core EXECUTES (the plugin only describes it). */
export interface Command {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * Descriptor of a deterministic aux port. The plugin provides the base and (optionally) an env key
 * that overrides it; the CORE allocates the concrete port (base + the project's index among the
 * dockerized ones + worktree offset) and puts it into ctx.extraPorts[name]. Stack-specific names (hmr,
 * RSPACK_DEVSERVER_PORT, 8085) live here, in the plugin, not in the core.
 */
export interface ExtraPortSpec {
  /** key in ctx.extraPorts (meteor: "hmr"). */
  name: string;
  /** deterministic base when envKey is not set in .env (meteor: 8085). */
  basePort: number;
  /** optional env key overriding the base, read from <projectDir>/.env (meteor: "RSPACK_DEVSERVER_PORT"). */
  envKey?: string;
}

/**
 * Where a stack keeps its installed dependencies and which files decide what to install.
 * The core writes its install fingerprint into `dir` (host: `<worktree>/<dir>/.wt-deps-hash`,
 * docker: a named volume per worktree derived from `dir`), reinstalls when `files` change, and
 * treats a missing `dir` as "nothing installed yet". Default: node's `node_modules` and the
 * npm/pnpm/yarn/bun manifest and lock files.
 */
export interface DepsSpec {
  /** directory relative to the worktree root (node: `node_modules`, cargo: `target`). */
  dir: string;
  /** files whose contents fingerprint the dependency set (node: `package.json` + locks). */
  files: string[];
}

/** Base context: everything the core knows about (project, slug) before launch. */
export interface PluginCtx {
  orch: string;
  project: string;
  slug: string;
  branch: string;
  projectDir: string;
  worktreeDir: string;
  config: ResolvedProjectConfig;
}

/** Worktree creation context (`wt new`): ports are not needed yet. */
export type WorktreeCtx = PluginCtx;

/** Context of a running instance: ports are computed, the container name is known. */
export interface InstanceCtx extends PluginCtx {
  port: number;
  offset: number;
  container: string;
  /** launch mode — determines how the plugin expresses the port and the flag syntax. */
  mode: "host" | "docker";
  /** path to the settings file for devCommand (the core computes it per mode: host=absolute/repo, docker=".wt-settings.json"); null if none. */
  settingsPath?: string | null;
  /** aux ports keyed by the names from plugin.extraPorts (computed deterministically by the core). */
  extraPorts: Record<string, number>;
}

/** Context for generating env lines. */
export interface EnvCtx extends InstanceCtx {}

/** Context for seeding an isolated DB. */
export interface SeedCtx extends InstanceCtx {
  /** base DB URL (from urlEnvKey in the project's .env). */
  baseDbUrl: string;
  /** target isolated URL (deriveUrl(baseDbUrl, suffix)). */
  isolatedDbUrl: string;
  /** command executor provided by the core (seam): the plugin builds argv, the core runs it. */
  run(argv: string[]): Promise<void>;
}

/**
 * Stack adapter contract. The plugin DESCRIBES (argv/lines/url), the core EXECUTES.
 * See design.md → StackPlugin.
 */
export interface StackPlugin {
  name: string;
  /**
   * Contract version the plugin was built against. Required when loading through loadPlugin
   * (bundled plugins set it); the type is optional only so that inline test fakes that bypass
   * loadPlugin still compile. A mismatch with PLUGIN_API_VERSION ⇒ loadPlugin throws.
   */
  apiVersion?: number;
  /** "dotenvx" → the core wraps devCommand in a dotenvx chain; "inline" (default) → as an env map. */
  envInjection?: "dotenvx" | "inline";
  install(ctx: WorktreeCtx): Command;
  /** dependency layout for the core's install/staleness check; default: node_modules + npm files. */
  deps?: DepsSpec;
  /** worktree directories (relative to its root) that install/build restores — `wt slim` removes them. */
  artifactDirs?: string[];
  devCommand(ctx: InstanceCtx): Command;
  /**
   * How long `wt start` waits for the instance port after spawning devCommand before it
   * reports "did NOT come up in time" (the process keeps running either way). Default: the
   * core's 10 minutes; a stack whose first start compiles the project (cargo) declares more.
   */
  upTimeoutMs?: number;
  envLines?(ctx: EnvCtx): string[];
  /** static lines appended to `.env.worktree` (after ROOT_URL); empty ⇒ nothing. */
  worktreeEnvTail?(ctx: WorktreeCtx): string[];
  /** aux ports: the core allocates one per spec (→ ctx.extraPorts[spec.name]). */
  extraPorts?: ExtraPortSpec[];
  resolveBasePort?(projectDir: string): Promise<number | null>;
  settingsFile?(ctx: InstanceCtx): string;
  isolatedDb?: {
    /** env key holding the DB URL (meteor: "MONGO_URL"). */
    urlEnvKey: string;
    deriveUrl(baseUrl: string, suffix: string): string;
    seed?(ctx: SeedCtx): Promise<void>;
  };
  docker?(ctx: InstanceCtx): {
    mounts: string[];
    addHosts?: string[];
    ownedVolumes?: string[];
    /** static `-e KEY=VALUE` for `docker run` (insertion order is preserved). */
    env?: Record<string, string>;
    /** per-line transform of the merged env applied AFTER the core's generic localhost→host remap. */
    envLineFilter?: (line: string) => string;
  };
}

/**
 * `envLineFilter` for Mongo URLs: appends `directConnection=true`.
 *
 * The dev Mongo runs as a replica set, so after the seed host the driver takes addresses from
 * the replica set config — and that says `127.0.0.1`, which inside a container points to the
 * container itself (ECONNREFUSED). `directConnection` disables discovery and keeps the driver
 * on the host given in the URL. Any dockerized stack talking to the shared dev Mongo needs it,
 * which is why it lives in the core rather than in a specific plugin.
 */
export const mongoDirectConnectionFilter = (line: string): string =>
  /^MONGO(_OPLOG)?_URL=mongodb/.test(line) && !line.includes("directConnection=")
    ? line + (line.includes("?") ? "&" : "?") + "directConnection=true"
    : line;

const REGISTRY = new Map<string, StackPlugin>();

/** Register a bundled plugin under its package name. Called from the bootstrap (Task 11) and tests. */
export function registerPlugin(name: string, plugin: StackPlugin): void {
  REGISTRY.set(name, plugin);
}

/**
 * Former private workspace plugin names → public specifiers. An old name is not
 * resolved silently: the user's config has to be updated explicitly.
 */
const LEGACY_PLUGIN_IDS: Record<string, string> = {
  "@wt/plugin-meteor": "@apartx/wt/plugin-meteor",
  "@wt/plugin-node": "@apartx/wt/plugin-node",
};

/**
 * Load a plugin by package name. For now only from the bundled-plugin registry
 * (M0–M3); npm resolution is an open M4 question (design.md).
 */
export async function loadPlugin(name: string): Promise<StackPlugin> {
  // Own-property check: a plain-object lookup would hit Object.prototype ("constructor", …).
  const renamed = Object.hasOwn(LEGACY_PLUGIN_IDS, name) ? LEGACY_PLUGIN_IDS[name] : undefined;
  if (renamed) throw new Error(`plugin: "${name}" was renamed to "${renamed}" — update "plugin" in wt.config.ts`);
  const p = REGISTRY.get(name);
  if (!p) throw new Error(`plugin: unknown plugin: ${name} (registered: ${[...REGISTRY.keys()].join(", ") || "—"})`);
  if (p.apiVersion !== PLUGIN_API_VERSION) {
    throw new Error(
      `plugin: ${name} is incompatible: apiVersion=${p.apiVersion ?? "not set"}, the core requires ${PLUGIN_API_VERSION}`,
    );
  }
  return p;
}
