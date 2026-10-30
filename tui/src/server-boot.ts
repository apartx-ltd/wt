import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { WT_PROTOCOL_VERSION, type WtMeta } from "#shared";
import { canonicalPath } from "#core";

/** GET /api/health → its `version`, or null if absent/unreachable/malformed. */
export async function fetchServerVersion(baseUrl: string): Promise<number | null> {
  try {
    const r = await fetch(`${baseUrl}/api/health`);
    if (!r.ok) return null;
    const body = (await r.json()) as { version?: unknown };
    return typeof body?.version === "number" ? body.version : null;
  } catch {
    return null;
  }
}

/** True if something at baseUrl answers /api/instances — i.e. it's a (possibly old) wt server. */
export async function isWtServer(baseUrl: string): Promise<boolean> {
  try {
    return (await fetch(`${baseUrl}/api/instances`)).ok;
  } catch {
    return false;
  }
}

/**
 * PIDs of the process *listening* on the TCP port (via lsof), or [] if none.
 * `-sTCP:LISTEN` is essential: a plain `lsof -i tcp:PORT` also matches *client*
 * connections to that port — including the socket our own fetch() just opened —
 * so without it killPort would SIGTERM the TUI's own process.
 */
async function pidsOnPort(port: number): Promise<number[]> {
  try {
    const proc = Bun.spawn(["lsof", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.split("\n").map((s) => s.trim()).filter(Boolean).map(Number).filter((n) => n > 0);
  } catch {
    return [];
  }
}

/**
 * Kill whatever process holds the TCP port and wait until it's actually free.
 * Polling (not a fixed sleep) avoids the EADDRINUSE race where a freshly spawned
 * server can't bind because the killed one hasn't released the port yet; escalates
 * to SIGKILL if SIGTERM doesn't take. Best-effort, no-op if the port is already free.
 */
export async function killPort(port: number): Promise<void> {
  for (const pid of await pidsOnPort(port)) {
    try { process.kill(pid); } catch { /* already gone */ }
  }
  for (let i = 0; i < 30; i++) {
    const pids = await pidsOnPort(port);
    if (pids.length === 0) return;
    if (i === 10) for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await Bun.sleep(100);
  }
}

export interface SpawnOpts {
  port: number;
  serverEntry: string;
  /** Workspace root the daemon drives — passed as WT_ORCH, so it never falls back to its cwd. */
  orch: string;
  /** Built web dashboard the daemon also serves (WT_STATIC_DIR, see ServerOpts.staticDir). */
  staticDir?: string;
}

function spawnServer(o: SpawnOpts): import("bun").Subprocess {
  return Bun.spawn([process.execPath, o.serverEntry], {
    env: {
      ...process.env,
      PORT: String(o.port),
      WT_ORCH: o.orch,
      ...(o.staticDir ? { WT_STATIC_DIR: o.staticDir } : {}),
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
}

/** GET /api/meta, or null if unreachable/malformed. `orch` is absent on pre-binding builds. */
export async function fetchServerMeta(baseUrl: string): Promise<Partial<WtMeta> | null> {
  try {
    const r = await fetch(`${baseUrl}/api/meta`);
    if (!r.ok) return null;
    const body = (await r.json()) as unknown;
    return body && typeof body === "object" ? (body as Partial<WtMeta>) : null;
  } catch {
    return null;
  }
}

/** HTTP status of GET / (the static dashboard shell), or null if unreachable. */
export async function fetchRootStatus(baseUrl: string): Promise<number | null> {
  try {
    const r = await fetch(`${baseUrl}/`);
    await r.body?.cancel();
    return r.status;
  } catch {
    return null;
  }
}

export interface BootDeps {
  fetchVersion?: (baseUrl: string) => Promise<number | null>;
  fetchMeta?: (baseUrl: string) => Promise<Partial<WtMeta> | null>;
  fetchRootStatus?: (baseUrl: string) => Promise<number | null>;
  isWtServer?: (baseUrl: string) => Promise<boolean>;
  killPort?: (port: number) => Promise<void>;
  spawnServer?: (o: SpawnOpts) => import("bun").Subprocess | undefined;
  sleep?: (ms: number) => Promise<void>;
}

export interface BootResult {
  baseUrl: string;
  spawned?: import("bun").Subprocess;
  replaced: boolean;
}

/**
 * Ensure a *current* wt-server for `orch` is listening on `port` and return its baseUrl.
 *
 * Reuses an existing server only if GET /api/health matches WT_PROTOCOL_VERSION, its
 * /api/meta reports the same workspace root, and — when a built `staticDir` is requested
 * — it serves the dashboard at `/`. Otherwise it is killed and replaced: a stale build
 * silently lingering makes newer routes (e.g. /logs) 404 — precisely how the log pane
 * broke after P2 added the logs route — a daemon bound to another workspace would drive
 * the wrong worktrees, and one started without WT_STATIC_DIR would 404 the `wt web` shell.
 */
export async function ensureServer(opts: SpawnOpts, deps: BootDeps = {}): Promise<BootResult> {
  const fv = deps.fetchVersion ?? fetchServerVersion;
  const fetchMeta = deps.fetchMeta ?? fetchServerMeta;
  const rootStatus = deps.fetchRootStatus ?? fetchRootStatus;
  const isWt = deps.isWtServer ?? isWtServer;
  const kill = deps.killPort ?? killPort;
  const spawn = deps.spawnServer ?? spawnServer;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const baseUrl = `http://localhost:${opts.port}`;

  const isReusable = async (): Promise<boolean> => {
    // One retry: a transient /api/meta failure must not replace a healthy daemon.
    let meta = await fetchMeta(baseUrl);
    if (meta === null) {
      await sleep(100);
      meta = await fetchMeta(baseUrl);
    }
    if (typeof meta?.orch !== "string" || canonicalPath(meta.orch) !== canonicalPath(opts.orch)) return false;
    const wantsStatic = !!opts.staticDir && existsSync(resolve(opts.staticDir, "index.html"));
    return !(wantsStatic && (await rootStatus(baseUrl)) === 404);
  };

  let replaced = false;
  if ((await fv(baseUrl)) === WT_PROTOCOL_VERSION) {
    if (await isReusable()) return { baseUrl, replaced }; // the right server is already up
    await kill(opts.port); // current protocol, wrong workspace or no static dir
    replaced = true;
  } else if (await isWt(baseUrl)) {
    await kill(opts.port); // an older wt-server holds the port; waits until it is free
    replaced = true;
  }

  const spawned = spawn(opts);
  for (let i = 0; i < 50; i++) {
    if ((await fv(baseUrl)) === WT_PROTOCOL_VERSION) return { baseUrl, spawned, replaced };
    await sleep(100);
  }
  throw new Error("wt-server did not come up");
}
