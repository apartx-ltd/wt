import { resolve, dirname } from "node:path";
import { existsSync, openSync } from "node:fs";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { spawn as cpSpawn } from "node:child_process";
import { containerName, dockerRemove } from "./containers";
import { BASE_SLUG, regenerateWorktreeEnvPreserving } from "./new-worktree";
import { resolveProjectConfig, resolveDockerizedProjects, resolveProjectsDir, type ResolvedProjectConfig, withProjectMounts } from "./config";
import { loadPlugin, type InstanceCtx, type StackPlugin } from "./plugin";
import { applyLinks } from "./links";
import {
  projectDir,
  worktreeDir,
  runFilePath,
  logFilePath,
  envFilePath,
  ovrFilePath,
  mergedEnvPath,
  dockerSettingsPath,
  runDir,
} from "./paths";
import { resolveBasePort, resolveAuxBasePort, readWorktreePort, readEnvValue } from "./ports";
import { mergeEnvFiles } from "./env-merge";
import { ensureDeps, ensureHostDeps, depsVolume } from "./deps";
import { applyStorage, ensureVolumeDirs, storageSource } from "./storage";
import {
  parseRunState,
  isInstanceAlive,
  formatRunState,
  defaultProbes,
  type AliveProbes,
} from "./run";

export interface DockerRunArgs {
  /** container name (wtdev-<p>-<slug>) */
  container: string;
  port: number;
  /** merged env-file (--env-file) */
  envFile: string;
  /** aux ports (name→number) from plugin.extraPorts; each is published as `-p <n>:<n>`. */
  extraPorts?: Record<string, number>;
  /** bind mounts/volumes (`-v`) provided by plugin.docker(ctx).mounts. */
  mounts: string[];
  /** add-hosts (`--add-host`): plugin.docker(ctx).addHosts + the dynamic dev host, in call order. */
  addHosts: string[];
  /** the `sh -c <innerCmd>` string (plugin.devCommand(ctx).argv.join(" ")). */
  innerCmd: string;
  /** docker image (ctx.config.docker.image). */
  image: string;
  /** optional ro mount of the rendered settings (var/run/<p>-<slug>.settings.docker.json → /opt/app/.wt-settings.json). */
  settingsMount?: string | null;
  /** static `-e KEY=VALUE` provided by plugin.docker(ctx).env (insertion order, before the generic NODE_OPTIONS). */
  dockerEnv?: Record<string, string>;
}

/**
 * argv for `docker run` of a dockerized instance (after the word `docker`). The core adds the
 * generic flags (`-d --name`, forced hot-reload polling, ipv4first DNS, publishing the
 * main port + one per extraPort, env-file); add-hosts, volumes,
 * image and inner-cmd come from the plugin (plugin.docker / plugin.devCommand).
 * Parity with the `docker run -d --name …` block in cmd_start.
 */
export function buildDockerRunArgs(a: DockerRunArgs): string[] {
  const args = ["run", "-d", "--name", a.container];
  for (const h of a.addHosts) args.push("--add-host", h);
  for (const [k, v] of Object.entries(a.dockerEnv ?? {})) args.push("-e", `${k}=${v}`);
  args.push(
    "-e", "NODE_OPTIONS=--dns-result-order=ipv4first",
    "-p", `${a.port}:${a.port}`,
  );
  for (const p of Object.values(a.extraPorts ?? {})) args.push("-p", `${p}:${p}`);
  args.push("--env-file", a.envFile);
  for (const m of a.mounts) args.push("-v", m);
  if (a.settingsMount) args.push("-v", `${a.settingsMount}:/opt/app/.wt-settings.json:ro`);
  args.push("-w", "/opt/app", a.image, "sh", "-c", a.innerCmd);
  return args;
}

/**
 * docker env for the container, accounting for the base checkout. The base (slug "base") has no
 * `.env.worktree` carrying the HMR/extra env → inject plugin.envLines (offset 0 ⇒
 * deterministic base HMR) as `-e`. Worktrees get them from the env-file (renderEnvFile),
 * so envLines are NOT added for them — a worktree's docker argv stays unchanged.
 */
export function baseCheckoutDockerEnv(
  slug: string,
  specEnv: Record<string, string> | undefined,
  pluginEnvLines: string[],
): Record<string, string> {
  const dockerEnv = { ...(specEnv ?? {}) };
  if (slug === BASE_SLUG) {
    for (const line of pluginEnvLines) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (m) dockerEnv[m[1]!] = m[2]!;
    }
  }
  return dockerEnv;
}

/**
 * Remap one env line for the container: `localhost`/`127.0.0.1`→host (EXCEPT ROOT_URL and the
 * project's `docker.keepLocalhost` keys — browser-facing origins).
 * Stack-specific tweaks (e.g. mongo directConnection) come from plugin.docker().envLineFilter,
 * which the core applies AFTER the generic remap. Parity with the sed+awk in render_env_file.
 */
export function remapEnvLine(line: string, host: string, filter?: (l: string) => string, keepLocalhost: string[] = []): string {
  let l = line;
  const key = l.slice(0, l.indexOf("="));
  if (key !== "ROOT_URL" && !keepLocalhost.includes(key)) l = l.replaceAll("localhost", host).replaceAll("127.0.0.1", host);
  return filter ? filter(l) : l;
}

/**
 * Deep-remap hosts in a settings object: `localhost`/`127.0.0.1`→host in all
 * string leaves EXCEPT the `public` subtree (it goes to the browser as-is). Parity with the
 * node walk in docker_settings.
 */
export function remapSettingsHosts(node: unknown, host: string, inPublic = false): unknown {
  if (Array.isArray(node)) return node.map((v) => remapSettingsHosts(v, host, inPublic));
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.keys(node as Record<string, unknown>).map((k) => [
        k,
        remapSettingsHosts((node as Record<string, unknown>)[k], host, inPublic || k === "public"),
      ]),
    );
  }
  if (typeof node === "string") return inPublic ? node : node.replaceAll("localhost", host).replaceAll("127.0.0.1", host);
  return node;
}

export interface HostMeteorArgs {
  /** absolute path of the project's base `.env` */
  baseEnv: string;
  /** `.env.worktree` is present (relative, cwd = worktree) */
  hasWorktreeEnv: boolean;
  /** absolute path of the link's env overlay (var/env/<p>-<slug>.env) or null */
  envOverlay?: string | null;
  /** inner command for `sh -c` (plugin.devCommand(ctx).argv.join(" ")), e.g. `meteor run --port $PORT`. */
  innerCmd: string;
}

/**
 * argv of a host start: `npx dotenvx run <fchain> -- sh -c "<innerCmd>"`. The dotenvx chain
 * (leftmost wins): env overlay → .env.worktree → base .env. innerCmd comes from the plugin
 * (plugin.devCommand). Parity with meteor_cmd.
 */
export function buildHostMeteorArgs(c: HostMeteorArgs): string[] {
  const f: string[] = [];
  if (c.envOverlay) f.push("-f", c.envOverlay);
  if (c.hasWorktreeEnv) f.push("-f", ".env.worktree");
  f.push("-f", c.baseEnv);
  return ["npx", "dotenvx", "run", ...f, "--", "sh", "-c", c.innerCmd];
}

const buildLockDir = (orch: string): string => resolve(runDir(orch), ".build.lock");

/** Serializes the build phase (mkdir spinlock; takes over a stale lock of a dead owner). Parity with acquire_build_lock. */
async function acquireBuildLock(orch: string, probes: AliveProbes): Promise<void> {
  await mkdir(runDir(orch), { recursive: true });
  const lock = buildLockDir(orch);
  let waited = 0;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch {
      const holder = Number.parseInt((await readFile(resolve(lock, "owner"), "utf8").catch(() => "")).trim(), 10);
      if (holder && !probes.pidAlive(holder)) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      await Bun.sleep(2000);
      waited += 2;
      if (waited >= 1200) await rm(lock, { recursive: true, force: true });
    }
  }
  await writeFile(resolve(lock, "owner"), String(process.pid));
}

async function releaseBuildLock(orch: string): Promise<void> {
  await rm(buildLockDir(orch), { recursive: true, force: true }).catch(() => {});
}

/** The core's wait for the instance port when the plugin declares no `upTimeoutMs`. */
export const DEFAULT_UP_TIMEOUT_MS = 600_000;

/** How long `wt start` waits for the port: the plugin's `upTimeoutMs`, else the core default. */
export function upTimeoutMs(plugin: Pick<StackPlugin, "upTimeoutMs">): number {
  return plugin.upTimeoutMs ?? DEFAULT_UP_TIMEOUT_MS;
}

/** Wait for the port to respond (build finished), or for the process to die / a timeout. Parity with wait_port_up. */
export async function waitPortUp(
  port: number,
  opts: { pid?: number; deadlineMs?: number; probes?: AliveProbes } = {},
): Promise<boolean> {
  const probes = opts.probes ?? defaultProbes;
  const deadline = Date.now() + (opts.deadlineMs ?? DEFAULT_UP_TIMEOUT_MS);
  while (Date.now() < deadline) {
    try {
      await fetch(`http://localhost:${port}`, { signal: AbortSignal.timeout(3000) });
      return true; // any HTTP response = up
    } catch {
      /* no response — keep waiting */
    }
    if (opts.pid !== undefined && !probes.pidAlive(opts.pid)) return false;
    await Bun.sleep(4000);
  }
  return false;
}

export async function gitBranch(dir: string): Promise<string> {
  const proc = Bun.spawn(["git", "-C", dir, "branch", "--show-current"], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out;
}

/** Start a process detached, as the leader of its own process group (kill -- -PGID on stop), log → file. */
export function spawnDetached(cmd: string, args: string[], cwd: string, logPath: string, env?: Record<string, string>): number {
  const fd = openSync(logPath, "a");
  const child = cpSpawn(cmd, args, {
    cwd, detached: true, stdio: ["ignore", fd, fd],
    env: env ? { ...process.env, ...env } : process.env,
  });
  child.unref();
  if (!child.pid) throw new Error("failed to start the process");
  return child.pid;
}

/**
 * mDNS name of the dev machine (<LocalHostName>.local); null on non-mac — `scutil` is missing
 * there and the spawn throws ENOENT, so docker mode falls back to host.docker.internal.
 * `argv` is a test seam. Parity with dev_host.
 */
export async function devHost(argv = ["scutil", "--get", "LocalHostName"]): Promise<string | null> {
  try {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return out ? `${out}.local` : null;
  } catch {
    return null;
  }
}

/**
 * Run a command with streamed stdio; throw on a non-zero exit code.
 * `hints` — a hint per exit code: docker prints the reason to its own stderr, but it
 * gets buried higher up in the log, so the most common one is repeated right in the error text.
 */
export async function shInherit(cmd: string[], hints?: Record<number, string>): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  const code = await proc.exited;
  if (code === 0) return;
  const hint = hints?.[code];
  throw new Error(`command exited with code ${code}: ${cmd.join(" ")}${hint ? `\n${hint}` : ""}`);
}

/** Scrape localhost defaults `process.env.X or 'scheme://…localhost…'` from the worktree sources (first one per key). */
async function scrapeLocalhostDefaults(dir: string): Promise<Map<string, string>> {
  const re = "process\\.env\\.[A-Z_0-9]+ *(or|\\|\\||\\?\\?) *['\"][a-z]+://[^'\"]*localhost[^'\"]*['\"]";
  const proc = Bun.spawn(
    ["grep", "-rhoE", re, dir, "--include=*.coffee", "--include=*.js", "--include=*.ts", "--exclude-dir=node_modules", "--exclude-dir=.meteor"],
    { stdout: "pipe", stderr: "ignore" },
  );
  const raw = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  const extract = /process\.env\.([A-Z_0-9]+).*['"]([a-z]+:\/\/[^'"]*localhost[^'"]*)['"]/;
  const lines = raw ? [...new Set(raw.split("\n").filter(Boolean))].sort() : [];
  const out = new Map<string, string>();
  for (const line of lines) {
    const m = extract.exec(line);
    if (m && !out.has(m[1]!)) out.set(m[1]!, m[2]!);
  }
  return out;
}

/**
 * Render the merged env-file for the container (`var/run/<p>-<slug>.env.merged`): dotenvx
 * from the MAIN checkout (that is where node_modules/dotenvx is) → filter by the files' keys →
 * remapEnvLine → scrape in the missing localhost defaults. Parity with render_env_file.
 */
export async function renderEnvFile(
  orch: string,
  project: string,
  slug: string,
  host: string,
  envLineFilter?: (l: string) => string,
  projectsDir = "projects",
  keepLocalhost: string[] = [],
): Promise<string> {
  const pdir = projectDir(orch, project, projectsDir);
  const dir = slug === BASE_SLUG ? pdir : worktreeDir(orch, project, slug);
  const wenv = resolve(dir, ".env.worktree");
  const envovr = envFilePath(orch, project, slug);
  const out = mergedEnvPath(orch, project, slug);

  const files = [resolve(pdir, ".env")];
  if (existsSync(wenv)) files.unshift(wenv);
  if (existsSync(envovr)) files.unshift(envovr);
  const keys = new Set<string>();
  for (const f of files) {
    if (!existsSync(f)) continue;
    for (const line of (await readFile(f, "utf8")).split("\n")) {
      // accept shell-style `export KEY=...` (the leading `export ` is stripped)
      const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
      if (m) keys.add(m[1]!);
    }
  }

  const fchain: string[] = [];
  if (existsSync(envovr)) fchain.push("-f", envovr);
  if (existsSync(wenv)) fchain.push("-f", wenv);
  fchain.push("-f", ".env");
  const proc = Bun.spawn(["npx", "dotenvx", "run", ...fchain, "--", "env"], { cwd: pdir, stdout: "pipe", stderr: "ignore" });
  const raw = await new Response(proc.stdout).text();
  await proc.exited;

  const values = new Map<string, string>();
  const addLine = (line: string) => {
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m || !keys.has(m[1]!)) return;
    values.set(m[1]!, m[2]!);
  };
  for (const line of raw.split("\n")) addLine(line);
  // dotenvx only exports keys from the "main" file (envovr → wenv → .env).
  // Add the missing ones from wenv/envovr by hand, so that PORT overrides
  // and HMR ports are not lost when they are absent from the base .env.
  // Limitation: raw values are taken from the files here (no ${VAR} expansion
  // and no dotenvx quote stripping). For numeric ports/URLs this is safe.
  for (const f of [wenv, envovr]) {
    if (!existsSync(f)) continue;
    for (const line of (await readFile(f, "utf8")).split("\n")) addLine(line);
  }
  // Fallback to the raw base `.env`: dotenvx above may not have run at all — it is resolved
  // via `npx` and is in node_modules only for projects that declare it as a dependency
  // (a non-Meteor stack does not pull it in; stderr is suppressed, so the failure is silent). Without this
  // the project's whole config was silently lost, and the instance came up on scrape defaults alone.
  // Only missing keys: where dotenvx did work, its values are more accurate (expanded
  // ${VAR}, stripped quotes).
  {
    const baseEnv = resolve(pdir, ".env");
    if (existsSync(baseEnv)) {
      for (const line of (await readFile(baseEnv, "utf8")).split("\n")) {
        const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
        if (m && !values.has(m[1]!)) values.set(m[1]!, m[2]!);
      }
    }
  }
  for (const [k, v] of await scrapeLocalhostDefaults(dir)) {
    if (values.has(k)) continue;
    values.set(k, v);
  }
  const remapped = [...values.entries()].map(([k, v]) => remapEnvLine(`${k}=${v}`, host, envLineFilter, keepLocalhost));
  const content = remapped.length ? remapped.join("\n") + "\n" : "";
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, content);
  return out;
}

/** Render settings for the container (public-aware remap) → mount path or null. Parity with docker_settings. */
export async function renderDockerSettings(orch: string, project: string, slug: string, host: string, projectsDir = "projects"): Promise<string | null> {
  const dir = slug === BASE_SLUG ? projectDir(orch, project, projectsDir) : worktreeDir(orch, project, slug);
  let src = "";
  if (existsSync(ovrFilePath(orch, project, slug))) src = ovrFilePath(orch, project, slug);
  else if (existsSync(resolve(dir, "settings", "settings.json"))) src = resolve(dir, "settings", "settings.json");
  else if (existsSync(resolve(dir, "settings.json"))) src = resolve(dir, "settings.json");
  if (!src) return null;
  const out = dockerSettingsPath(orch, project, slug);
  const remapped = remapSettingsHosts(JSON.parse(await readFile(src, "utf8")), host);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(remapped, null, 2) + "\n");
  return out;
}

export interface StartOptions {
  /** "all" — all upstreams of the consumer; otherwise the name of a single upstream target (filter). */
  link?: "all" | string;
  /** slug of the target worktrees for links (defaults to the instance's own slug). */
  linkSlug?: string;
}

export interface StartResult {
  project: string;
  slug: string;
  port: number;
  pid: number | null;
  container: string | null;
  branch: string;
  portUp: boolean;
}

/**
 * `wt start` (background). Common checks → links → branch into host (detached process)
 * / docker (container). Parity with cmd_start. Gates the host build behind the build lock, writes the
 * runfile, waits for the port.
 */
export async function startInstance(
  orch: string,
  project: string,
  slug: string,
  opts: StartOptions = {},
  probes: AliveProbes = defaultProbes,
): Promise<StartResult> {
  const projectsDir = await resolveProjectsDir(orch);
  const isBase = slug === BASE_SLUG;
  const dir = isBase ? projectDir(orch, project, projectsDir) : worktreeDir(orch, project, slug);
  if (!existsSync(dir)) throw new Error(`no worktree: ${project}/${slug} (create it: wt new ${project} ${slug})`);

  const rf = runFilePath(orch, project, slug);
  const existing = await parseRunState(rf);
  if (existing && (await isInstanceAlive(existing, probes))) {
    const who = existing.container ?? `PID ${existing.pid ?? "?"}`;
    throw new Error(`${project}/${slug} is already running (${who}, port ${existing.port ?? "?"})`);
  }

  if (!isBase) {
    await regenerateWorktreeEnvPreserving(orch, project, await gitBranch(dir), dir);
  }

  if (opts.link) {
    await applyLinks(orch, project, slug, opts.linkSlug ?? slug, opts.link === "all" ? undefined : opts.link);
  }

  const port = isBase ? await resolveBasePort(projectDir(orch, project, projectsDir)) : await readWorktreePort(dir);
  if (port === null) throw new Error(`${project}/${slug}: no PORT found (base .env / .env.worktree)`);
  const branch = await gitBranch(dir);

  const config = await resolveProjectConfig(orch, project);
  return config.docker?.image
    ? startDockerized(orch, project, slug, dir, port, branch, projectsDir)
    : startHost(orch, project, slug, dir, port, branch, probes, projectsDir);
}

/** Resolve the host `--settings` (ovr → repo settings/settings.json → settings.json) or null. */
function resolveHostSettings(orch: string, project: string, slug: string, dir: string): string | null {
  if (existsSync(ovrFilePath(orch, project, slug))) return ovrFilePath(orch, project, slug);
  if (existsSync(resolve(dir, "settings", "settings.json"))) return "settings/settings.json";
  if (existsSync(resolve(dir, "settings.json"))) return "settings.json";
  return null;
}

/**
 * Build the `InstanceCtx` for the plugin. port/offset/container/extraPorts come from the core;
 * settingsPath is per mode (host: absolute/repo `--settings` path, docker: `.wt-settings.json`
 * when there is a mount). In host mode the meteor plugin does not use offset/extraPorts,
 * but the context stays type-safe.
 */
function buildInstanceCtx(args: {
  orch: string;
  project: string;
  slug: string;
  dir: string;
  branch: string;
  config: ResolvedProjectConfig;
  port: number;
  offset: number;
  container: string;
  mode: "host" | "docker";
  settingsPath: string | null;
  extraPorts: Record<string, number>;
  projectsDir?: string;
}): InstanceCtx {
  return {
    orch: args.orch,
    project: args.project,
    slug: args.slug,
    branch: args.branch,
    projectDir: projectDir(args.orch, args.project, args.projectsDir),
    worktreeDir: args.dir,
    config: args.config,
    port: args.port,
    offset: args.offset,
    container: args.container,
    mode: args.mode,
    settingsPath: args.settingsPath,
    extraPorts: args.extraPorts,
  };
}

/**
 * Host start argv. The plugin describes the inner cmd (`plugin.devCommand(ctx).argv`); the core
 * wraps it: with `envInjection==="dotenvx"` — in a dotenvx chain (env overlay → .env.worktree
 * → base .env) + `sh -c <inner>` (parity with meteor_cmd); otherwise inline as an env map.
 */
export async function buildHostDevArgs(args: {
  orch: string;
  project: string;
  slug: string;
  dir: string;
  branch: string;
  port: number;
  plugin: StackPlugin;
  config: ResolvedProjectConfig;
  projectsDir?: string;
}): Promise<{ argv: string[]; env?: Record<string, string> }> {
  const { orch, project, slug, dir, projectsDir } = args;
  const settings = resolveHostSettings(orch, project, slug, dir);
  const ctx = buildInstanceCtx({
    orch, project, slug, dir, branch: args.branch, config: args.config,
    port: args.port, offset: 0, container: containerName(project, slug),
    mode: "host", settingsPath: settings, extraPorts: {}, projectsDir,
  });
  const cmd = args.plugin.devCommand(ctx);
  const inner = cmd.argv.join(" ");
  // Inject the engine-resolved PORT as a fallback. The base checkout (slug "base") has no
  // `.env.worktree` carrying a deterministic PORT, and a project's base `.env` often omits
  // PORT entirely (e.g. apartx-spaces keeps it in package.json). For meteor (`$PORT` in the
  // dotenvx innerCmd) that left $PORT empty → "the --port option needs a value" — it only
  // "worked" before by inheriting a stray PORT from the parent. PORT is set FIRST so any
  // file-provided PORT (.env / .env.worktree, which equals args.port for worktrees) wins;
  // dotenvx likewise won't override this already-set env var, so the resolved port governs.
  if (args.plugin.envInjection === "dotenvx") {
    const envOverlay = existsSync(envFilePath(orch, project, slug)) ? envFilePath(orch, project, slug) : null;
    const hasWtree = slug !== BASE_SLUG && existsSync(resolve(dir, ".env.worktree"));
    return {
      argv: buildHostMeteorArgs({ baseEnv: resolve(projectDir(orch, project, projectsDir), ".env"), hasWorktreeEnv: hasWtree, envOverlay, innerCmd: inner }),
      env: { PORT: String(args.port) },
    };
  }
  // inline: the core itself layers the env files (base .env → .env.worktree → the link's env overlay;
  // later = higher priority) into a map, plus whatever the plugin returned in Command.env.
  const envOverlay = existsSync(envFilePath(orch, project, slug)) ? envFilePath(orch, project, slug) : null;
  const hasWtree = slug !== BASE_SLUG && existsSync(resolve(dir, ".env.worktree"));
  const layered = await mergeEnvFiles([
    resolve(projectDir(orch, project, projectsDir), ".env"),
    ...(hasWtree ? [resolve(dir, ".env.worktree")] : []),
    ...(envOverlay ? [envOverlay] : []),
  ]);
  return { argv: ["sh", "-c", inner], env: { PORT: String(args.port), ...layered, ...(cmd.env ?? {}) } };
}

/**
 * `wt run` (foreground, host). The same host args as `start`, but stdio is inherited and the
 * process is not detached (Ctrl-C ends it). No runfile/build lock. Parity with cmd_run.
 * dockerized → throws (node_modules lives in a volume; use `wt start` + `wt logs -f`).
 */
export async function runForeground(
  orch: string,
  project: string,
  slug: string,
  opts: StartOptions = {},
): Promise<number> {
  const config = await resolveProjectConfig(orch, project);
  if (config.docker?.image)
    throw new Error(`${project} is dockerized: foreground is unavailable, use: wt start ${project} ${slug} && wt logs ${project} ${slug} -f`);
  const projectsDir = await resolveProjectsDir(orch);
  const isBase = slug === BASE_SLUG;
  const dir = isBase ? projectDir(orch, project, projectsDir) : worktreeDir(orch, project, slug);
  if (!existsSync(dir)) throw new Error(`no worktree: ${project}/${slug} (create it: wt new ${project} ${slug})`);
  if (!isBase) {
    await regenerateWorktreeEnvPreserving(orch, project, await gitBranch(dir), dir);
  }
  if (opts.link) await applyLinks(orch, project, slug, opts.linkSlug ?? slug, opts.link === "all" ? undefined : opts.link);
  const plugin = await loadPlugin(config.plugin);
  const port = isBase ? (await resolveBasePort(projectDir(orch, project, projectsDir))) ?? 0 : (await readWorktreePort(dir)) ?? 0;
  const branch = await gitBranch(dir);
  await ensureHostDeps(dir, plugin.install({ orch, project, slug, branch, projectDir: projectDir(orch, project, projectsDir), worktreeDir: dir, config }).argv, plugin.deps);
  const { argv, env } = await buildHostDevArgs({ orch, project, slug, dir, branch, port, plugin, config, projectsDir });
  const proc = Bun.spawn(argv, { cwd: dir, env: env ? { ...process.env, ...env } : process.env, stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  return await proc.exited;
}

async function startHost(
  orch: string,
  project: string,
  slug: string,
  dir: string,
  port: number,
  branch: string,
  probes: AliveProbes,
  projectsDir: string,
): Promise<StartResult> {
  const config = await resolveProjectConfig(orch, project);
  const plugin = await loadPlugin(config.plugin);
  await ensureHostDeps(dir, plugin.install({ orch, project, slug, branch, projectDir: projectDir(orch, project, projectsDir), worktreeDir: dir, config }).argv, plugin.deps);
  const { argv: args, env } = await buildHostDevArgs({ orch, project, slug, dir, branch, port, plugin, config, projectsDir });

  await acquireBuildLock(orch, probes);
  try {
    const pid = spawnDetached(args[0]!, args.slice(1), dir, logFilePath(orch, project, slug), env);
    await writeFile(runFilePath(orch, project, slug), formatRunState({ pid, port, branch, started: Math.floor(Date.now() / 1000), project, slug, pgroup: true }));
    const portUp = await waitPortUp(port, { pid, probes, deadlineMs: upTimeoutMs(plugin) });
    return { project, slug, port, pid, container: null, branch, portUp };
  } finally {
    await releaseBuildLock(orch);
  }
}

async function startDockerized(
  orch: string,
  project: string,
  slug: string,
  dir: string,
  port: number,
  branch: string,
  projectsDir: string,
): Promise<StartResult> {
  const container = containerName(project, slug);
  const config = await resolveProjectConfig(orch, project);
  const plugin = await loadPlugin(config.plugin);
  const dh = await devHost();
  const host = dh ?? "host.docker.internal";
  // Removing the previous container (including a stuck Exited one) is MANDATORY: otherwise docker run
  // below fails with 125 "name is already in use", and without this check the cause is invisible.
  await dockerRemove([container]);

  // dockerSpec is captured once BEFORE the env is rendered: meteor.docker() does not read extraPorts,
  // so a ctx with extraPorts:{} yields the same mounts/addHosts/env/envLineFilter; the real
  // extraPorts are computed below from the merged env and used only in devCommand/buildDockerRunArgs.
  const specCtx = buildInstanceCtx({
    orch, project, slug, dir, branch, config,
    port, offset: 0, container, mode: "docker", settingsPath: null, extraPorts: {}, projectsDir,
  });
  const dockerSpec = plugin.docker?.(specCtx) ?? { mounts: [] };
  // the plugin's volumes, then the project's own `docker.mounts` (files outside the worktree);
  // in dir storage the instance's own volumes become directories under docker.storageDir.
  const storage = config.docker?.storage ?? "volume";
  const owned = dockerSpec.ownedVolumes ?? [];
  await ensureVolumeDirs(orch, owned, storage, config.docker?.storageDir);
  const mounts = applyStorage(withProjectMounts(dockerSpec.mounts, config.docker, orch), owned, storage, orch, config.docker?.storageDir);
  const depsSource = storageSource(orch, depsVolume(container, plugin.deps), storage, config.docker?.storageDir);

  // Dependency install comes after dockerSpec: both the volume layout and the command itself come
  // from the plugin (meteor → `meteor npm install` + meteor volumes, node → `npm install` without them).
  await ensureDeps(dir, container, config.docker!.image, mounts, plugin.install(specCtx).argv, plugin.deps, depsSource);

  const envFile = await renderEnvFile(orch, project, slug, host, dockerSpec.envLineFilter, projectsDir, config.docker?.keepLocalhost);
  const settingsMount = await renderDockerSettings(orch, project, slug, host, projectsDir);

  // Aux ports (generic): for each spec take the env override from the merged env, otherwise the
  // dockerized-indexed base. offset=0 (the value in .env.worktree already includes the offset).
  const dockerized = await resolveDockerizedProjects(orch);
  const extraPorts: Record<string, number> = {};
  for (const spec of plugin.extraPorts ?? []) {
    const fromEnv = spec.envKey ? await readEnvValue(envFile, spec.envKey) : null;
    extraPorts[spec.name] = fromEnv
      ? Number(fromEnv)
      : await resolveAuxBasePort(projectDir(orch, project, projectsDir), project, spec, dockerized);
  }

  const ctx = buildInstanceCtx({
    orch, project, slug, dir, branch, config,
    port, offset: 0, container, mode: "docker",
    settingsPath: settingsMount ? ".wt-settings.json" : null,
    extraPorts, projectsDir,
  });
  // add-hosts: the plugin's static ones, then the dynamic dev host (order of the current code).
  const addHosts = [...(dockerSpec.addHosts ?? []), ...(dh ? [`${dh}:host-gateway`] : [])];
  const innerCmd = plugin.devCommand(ctx).argv.join(" ");
  // The base (slug "base") has no .env.worktree → inject plugin.envLines (HMR) as `-e`.
  const dockerEnv = baseCheckoutDockerEnv(slug, dockerSpec.env, plugin.envLines?.(ctx) ?? []);
  const args = buildDockerRunArgs({
    container, port, envFile, extraPorts,
    mounts, addHosts, innerCmd, image: config.docker!.image, settingsMount,
    dockerEnv,
  });
  await shInherit(["docker", ...args], {
    125: `docker could not create container ${container}. If the name is taken, remove it manually: docker rm -f ${container}`,
  });
  await writeFile(runFilePath(orch, project, slug), formatRunState({ container, port, branch, started: Math.floor(Date.now() / 1000), project, slug }));
  const portUp = await waitPortUp(port, { deadlineMs: upTimeoutMs(plugin) });
  return { project, slug, port, pid: null, container, branch, portUp };
}
