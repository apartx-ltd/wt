import { resolve, basename } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile, appendFile, readFile, unlink, rm } from "node:fs/promises";
import { resolveBasePort, resolveAuxBasePort, readLedger, allocateOffset, appendLedger, upsertLedger, readEnvValue } from "./ports";
import { generateEnvWorktree, branchDbSuffix } from "./env-worktree";
import { containerName } from "./containers";
import { loadPlugin, type EnvCtx, type InstanceCtx, type StackPlugin } from "./plugin";
import { loadConfig, resolveProjectConfig, resolveDockerizedProjects, resolveProjectsDir, resolvePortStep } from "./config";
import { stopInstance } from "./run";
import { installDockerDeps, installHostDeps } from "./deps";
import {
  projectDir,
  worktreeDir,
  mergedEnvPath,
  dockerSettingsPath,
  ovrFilePath,
  envFilePath,
} from "./paths";

/** The base slug = the base checkout (projects/<p>); reserved — not a worktree. */
export const BASE_SLUG = "base";

/** Run a command with streamed stdio; throw on a non-zero exit code. */
async function sh(cmd: string[], cwd?: string): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`command exited with code ${code}: ${cmd.join(" ")}`);
}

/** true if the command exited with code 0 (output suppressed). */
async function shOk(cmd: string[], cwd?: string): Promise<boolean> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "ignore" });
  return (await proc.exited) === 0;
}

/** Add `.env.worktree` to `<git-common-dir>/info/exclude` (parity with worktree-env.sh). */
async function addInfoExclude(worktreeDir: string): Promise<void> {
  const proc = Bun.spawn(["git", "-C", worktreeDir, "rev-parse", "--git-common-dir"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  if (!out) return;
  const excl = resolve(resolve(worktreeDir, out), "info", "exclude");
  if (!existsSync(excl)) return;
  const cur = await readFile(excl, "utf8");
  if (!cur.split("\n").includes(".env.worktree")) await appendFile(excl, ".env.worktree\n");
}

export interface ComputedWorktreeEnv {
  offset: number;
  port: number;
  content: string;
  /** true if the branch is not in the ledger yet (offset just allocated, not written). */
  isNew: boolean;
  /** true if the branch was in the ledger, but its port is taken by the system and it moved to a new offset. */
  reallocated: boolean;
}

/**
 * Compute `.env.worktree` for (project, branch) WITHOUT writing it: base port +
 * offset (the existing one from the ledger or the next free one) + contents. For an already
 * known branch it is fully read-only (offset from the ledger) — suitable for comparing against
 * a live worktree. `isolatedDb` adds MONGO_URL from the project's base `.env`.
 */
export async function computeWorktreeEnv(
  orch: string,
  project: string,
  branch: string,
  opts: { isolatedDb?: boolean } = {},
): Promise<ComputedWorktreeEnv> {
  const pdir = projectDir(orch, project, await resolveProjectsDir(orch));
  const basePort = await resolveBasePort(pdir);
  if (basePort === null) throw new Error(`no PORT found in .env/package.json of project ${project}`);
  const config = await resolveProjectConfig(orch, project);
  const baseRootUrl = (await readEnvValue(resolve(pdir, ".env"), "ROOT_URL")) ?? `http://localhost:${basePort}`;

  const ledger = await readLedger(orch);
  const existingRow = ledger.find((r) => r.project === project && r.branch === branch);
  const isNew = !existingRow;
  const offset = allocateOffset(ledger, project, branch, basePort, await resolvePortStep(orch));
  // The branch was already in the ledger, but its port is taken by the system (BLOCKED_PORTS) — move it.
  const reallocated = !!existingRow && existingRow.offset !== offset;

  let baseMongo: string | undefined;
  if (opts.isolatedDb) {
    const m = await readEnvValue(resolve(pdir, ".env"), "MONGO_URL");
    if (!m) throw new Error(`no MONGO_URL= in the .env of project ${project} for --isolated-db`);
    baseMongo = m;
  }

  // Aux ports come from plugin.extraPorts (generic). Allocate a port only if the project is
  // dockerized OR the aux port's env override is set explicitly in .env (host mode without it — skip,
  // deterministicAuxBasePort would throw outside the dockerized set). Parity with the former hmr case.
  const plugin = await loadPlugin(config.plugin);
  const dockerized = await resolveDockerizedProjects(orch);
  const extraPorts: Record<string, number> = {};
  for (const spec of plugin.extraPorts ?? []) {
    const explicit = spec.envKey ? await readEnvValue(resolve(pdir, ".env"), spec.envKey) : null;
    if (config.docker?.image || explicit !== null) {
      extraPorts[spec.name] = (await resolveAuxBasePort(pdir, project, spec, dockerized)) + offset;
    }
  }
  const envCtx: EnvCtx = {
    orch, project, slug: branch, branch,
    projectDir: pdir, worktreeDir: pdir, config,
    port: basePort + offset, offset, container: "", mode: "docker",
    settingsPath: null, extraPorts,
  };
  const extraEnvLines = plugin.envLines ? plugin.envLines(envCtx) : [];
  // Tail lines (.env.worktree after ROOT_URL) come from the plugin (meteor: MONGO_OPLOG_URL=,
  // MONTI_*). The isolated <urlEnvKey>= goes through the same isolatedDb contract as --seed.
  const tailLines = [...(plugin.worktreeEnvTail?.(envCtx) ?? [])];
  if (opts.isolatedDb && plugin.isolatedDb && baseMongo) {
    const { urlEnvKey, deriveUrl } = plugin.isolatedDb;
    tailLines.push(`${urlEnvKey}=${deriveUrl(baseMongo, branchDbSuffix(branch))}`);
  }
  // Project env from wt.config.ts — wt-managed keys, just like the plugin's lines. The base checkout
  // does not get them (it has no .env.worktree): that is exactly what namespaces like CHATS_QUEUE_NS need.
  const vars: Record<string, string> = {
    port: String(basePort + offset),
    offset: String(offset),
    branchSuffix: branchDbSuffix(branch),
  };
  for (const [key, template] of Object.entries(config.env ?? {})) {
    tailLines.push(`${key}=${template.replace(/\$\{(\w+)\}/g, (m, name) => vars[name] ?? m)}`);
  }
  const content = generateEnvWorktree({ project, branch, offset, basePort, extraEnvLines, baseRootUrl, tailLines });
  return { offset, port: basePort + offset, content, isNew, reallocated };
}

/**
 * Write `.env.worktree` into the worktree directory and (if the branch is new) append the offset
 * to the ledger. Returns the computed values. Parity with worktree-env.sh.
 */
export async function commitWorktreeEnv(
  orch: string,
  project: string,
  branch: string,
  worktreeDir: string,
  opts: { isolatedDb?: boolean } = {},
): Promise<ComputedWorktreeEnv> {
  const computed = await computeWorktreeEnv(orch, project, branch, opts);
  await mkdir(worktreeDir, { recursive: true });
  await writeFile(resolve(worktreeDir, ".env.worktree"), computed.content);
  if (computed.isNew) await appendLedger(orch, project, branch, computed.offset);
  else if (computed.reallocated) await upsertLedger(orch, project, branch, computed.offset);
  return computed;
}

/** Parse `.env.worktree` into Map<KEY, full-line> (comments/empty lines ignored). */
function envLinesByKey(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split("\n")) {
    const mm = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (mm) m.set(mm[1]!, line);
  }
  return m;
}

/**
 * Regenerate `.env.worktree` while PRESERVING unmanaged keys. wt-managed keys
 * (PORT/ROOT_URL/plugin envLines/worktreeEnvTail/isolated urlEnvKey) are rewritten to their
 * current deterministic values; everything else (manual additions) is kept verbatim.
 * Isolated mode is inferred from the PRESENCE of urlEnvKey in the current file — regeneration NEVER
 * switches isolated↔shared. Idempotent on a canonically generated file.
 */
export async function regenerateWorktreeEnvPreserving(
  orch: string,
  project: string,
  branch: string,
  worktreeDir: string,
): Promise<ComputedWorktreeEnv> {
  const path = resolve(worktreeDir, ".env.worktree");
  const existing = existsSync(path) ? envLinesByKey(await readFile(path, "utf8")) : new Map<string, string>();

  const config = await resolveProjectConfig(orch, project);
  const plugin = await loadPlugin(config.plugin);
  const urlKey = plugin.isolatedDb?.urlEnvKey;
  const isolatedDb = urlKey ? existing.has(urlKey) : false;

  const computed = await computeWorktreeEnv(orch, project, branch, { isolatedDb });
  const managed = new Set(envLinesByKey(computed.content).keys());

  const preserved: string[] = [];
  for (const [k, line] of existing) if (!managed.has(k)) preserved.push(line);

  const content = preserved.length
    ? computed.content.replace(/\n$/, "\n") + preserved.join("\n") + "\n"
    : computed.content;

  await mkdir(worktreeDir, { recursive: true });
  await writeFile(path, content);
  if (computed.isNew) await appendLedger(orch, project, branch, computed.offset);
  else if (computed.reallocated) await upsertLedger(orch, project, branch, computed.offset);
  return computed;
}

export interface CreateWorktreeOpts {
  isolatedDb?: boolean;
  seed?: boolean;
}
export interface CreateWorktreeResult {
  dir: string;
  branch: string;
  port: number;
  offset: number;
}

/**
 * Full `wt new`: git worktree add (+branch) → submodule init → `meteor npm install`
 * (docker for dockerized projects, host otherwise) → write `.env.worktree`+ledger → info/exclude.
 * Parity with cmd_new (scripts/wt-legacy). `--seed` is delegated to the plugin
 * (`plugin.isolatedDb.seed`; the core executes the dump/restore via `sh`).
 */
export async function createWorktree(
  orch: string,
  project: string,
  slug: string,
  opts: CreateWorktreeOpts = {},
): Promise<CreateWorktreeResult> {
  if (slug === BASE_SLUG)
    throw new Error(`slug '${BASE_SLUG}' is reserved for the base checkout — cannot be created as a worktree`);
  if (opts.seed && !opts.isolatedDb) throw new Error("--seed requires --isolated-db");

  const pdir = projectDir(orch, project, await resolveProjectsDir(orch));
  if (!existsSync(resolve(pdir, ".git"))) throw new Error(`no such project: ${project} (expected ${pdir})`);
  const dir = resolve(orch, "worktrees", project, slug);
  if (existsSync(dir)) throw new Error(`worktree already exists: ${dir}`);
  // Resolve the plugin before touching git: a bad plugin id (e.g. a renamed one) must not
  // leave a half-made worktree and branch behind.
  const config = await resolveProjectConfig(orch, project);
  const plugin = await loadPlugin(config.plugin);

  // Branch name and fork point come from config.branches (M2.5). The prefix governs slug↔branch,
  // base is the starting point of the new branch (apartx: "develop"), not the current HEAD of the base
  // checkout. base undefined (no config) ⇒ fall back to HEAD.
  const cfg = await loadConfig(orch, basename(orch)).catch(() => null);
  const prefix = cfg?.branches.prefix ?? "feature/";
  const base = cfg?.branches.base;
  const branch = `${prefix}${slug}`;
  const hasBranch = await shOk(["git", "-C", pdir, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  await sh(
    hasBranch
      ? ["git", "-C", pdir, "worktree", "add", dir, branch]
      : base
        ? ["git", "-C", pdir, "worktree", "add", dir, "-b", branch, base]
        : ["git", "-C", pdir, "worktree", "add", dir, "-b", branch],
  );

  // git worktree add does NOT init submodules — without them Meteor fails on local packages
  if (existsSync(resolve(dir, ".gitmodules"))) {
    await sh(["git", "-C", dir, "submodule", "update", "--init", "--recursive"]);
  }

  const cn = containerName(project, slug);
  // install: the plugin describes the command; the core executes it (host — in the worktree directory,
  // docker — inside `docker run --rm` with the same volumes/image as on start).
  const installCtx: InstanceCtx = {
    orch, project, slug, branch,
    projectDir: pdir, worktreeDir: dir, config,
    port: 0, offset: 0, container: cn, mode: config.docker?.image ? "docker" : "host",
    settingsPath: null, extraPorts: {},
  };
  const installArgv = plugin.install(installCtx).argv;
  if (config.docker?.image) {
    await installDockerDeps(dir, cn, config.docker!.image, plugin.docker!(installCtx).mounts, installArgv, plugin.deps);
  } else {
    await installHostDeps(dir, installArgv, plugin.deps);
  }

  const computed = await commitWorktreeEnv(orch, project, branch, dir, { isolatedDb: opts.isolatedDb });
  await addInfoExclude(dir);

  if (opts.isolatedDb && opts.seed) {
    // Config-driven: the DB-URL key and derive come from plugin.isolatedDb; the core executes the seed (sh).
    const iso = plugin.isolatedDb;
    if (!iso?.seed) throw new Error(`plugin ${config.plugin}: no isolatedDb.seed for --seed`);
    const baseMongo = await readEnvValue(resolve(pdir, ".env"), iso.urlEnvKey);
    if (!baseMongo) throw new Error(`no ${iso.urlEnvKey} in the .env of project ${project} for --seed`);
    const isoMongo = iso.deriveUrl(baseMongo, branchDbSuffix(branch)); // target = <db>_<suffix>, NOT the base DB
    await iso.seed({
      baseDbUrl: baseMongo,
      isolatedDbUrl: isoMongo,
      run: sh,
    } as any);
  }

  return { dir, branch, port: computed.port, offset: computed.offset };
}

/**
 * Per-worktree docker volumes of an instance, as the plugin's `docker()` declares them
 * (`ownedVolumes`). A plugin without `docker()` gets the legacy meteor pair — the names
 * `wt rm` removed before plugins described their own layout.
 */
export function instanceVolumes(plugin: StackPlugin | null, ctx: InstanceCtx): string[] {
  const owned = plugin?.docker?.(ctx).ownedVolumes;
  return owned ?? [`${ctx.container}-node_modules`, `${ctx.container}-meteor_local`];
}

export interface RemoveWorktreeOpts {
  /** also delete the feature/<slug> branch (git branch -d). */
  dropBranch?: boolean;
}

/**
 * `wt rm <p> <slug>`: stop the instance (if running) → for dockerized, remove the
 * per-worktree volumes + merged env/settings → remove run/link artifacts → `git
 * worktree remove` (with a force fallback) + prune → optionally branch -d. The branch's port
 * stays in the ledger (reserved). Parity with cmd_rm.
 */
export async function removeWorktree(
  orch: string,
  project: string,
  slug: string,
  opts: RemoveWorktreeOpts = {},
): Promise<void> {
  if (slug === BASE_SLUG)
    throw new Error(`the base checkout (slug '${BASE_SLUG}') cannot be removed with wt rm — it is projects/${project}`);
  const pdir = projectDir(orch, project, await resolveProjectsDir(orch));
  if (!existsSync(resolve(pdir, ".git"))) throw new Error(`no such project: ${project} (expected ${pdir})`);
  const dir = worktreeDir(orch, project, slug);

  await stopInstance(orch, project, slug); // stop + remove the runfile (no-op if not running)

  const config = await resolveProjectConfig(orch, project);
  if (config.docker?.image) {
    const cn = containerName(project, slug);
    // A plugin that no longer loads (renamed id) must not keep the worktree around: fall back
    // to the legacy volume names. docker() reads worktreeDir/container only — the rest of ctx is there for the type.
    const plugin = await loadPlugin(config.plugin).catch(() => null);
    const volumes = instanceVolumes(plugin, {
      orch, project, slug, branch: "", projectDir: pdir, worktreeDir: dir, config,
      port: 0, offset: 0, container: cn, mode: "docker", settingsPath: null, extraPorts: {},
    });
    if (volumes.length) await shOk(["docker", "volume", "rm", ...volumes]);
    await unlink(mergedEnvPath(orch, project, slug)).catch(() => {});
    await unlink(dockerSettingsPath(orch, project, slug)).catch(() => {});
  }
  await unlink(ovrFilePath(orch, project, slug)).catch(() => {});
  await unlink(envFilePath(orch, project, slug)).catch(() => {});

  if (!(await shOk(["git", "-C", pdir, "worktree", "remove", dir]))) {
    await shOk(["git", "-C", pdir, "worktree", "remove", "--force", dir]);
  }
  await shOk(["git", "-C", pdir, "worktree", "prune"]);
  if (opts.dropBranch) {
    const cfg = await loadConfig(orch, basename(orch)).catch(() => null);
    const prefix = cfg?.branches.prefix ?? "feature/";
    await shOk(["git", "-C", pdir, "branch", "-d", `${prefix}${slug}`]);
  }
}
