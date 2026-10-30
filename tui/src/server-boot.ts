import { WT_PROTOCOL_VERSION } from "#shared";

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

function spawnServer(port: number, serverEntry: string): import("bun").Subprocess {
  return Bun.spawn(["bun", serverEntry], {
    env: { ...process.env, PORT: String(port) },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
}

export interface BootDeps {
  fetchVersion?: (baseUrl: string) => Promise<number | null>;
  isWtServer?: (baseUrl: string) => Promise<boolean>;
  killPort?: (port: number) => Promise<void>;
  spawnServer?: (port: number, serverEntry: string) => import("bun").Subprocess | undefined;
  sleep?: (ms: number) => Promise<void>;
}

export interface BootResult {
  baseUrl: string;
  spawned?: import("bun").Subprocess;
  replaced: boolean;
}

/**
 * Ensure a *current* wt-server is listening on `port` and return its baseUrl.
 *
 * Reuses an existing server only if GET /api/health matches WT_PROTOCOL_VERSION.
 * If an older/incompatible wt-server holds the port, it is killed and replaced —
 * otherwise a stale build silently lingers and newer routes (e.g. /logs) 404,
 * which is precisely how the log pane broke after P2 added the logs route.
 */
export async function ensureServer(
  opts: { port: number; serverEntry: string },
  deps: BootDeps = {},
): Promise<BootResult> {
  const fv = deps.fetchVersion ?? fetchServerVersion;
  const isWt = deps.isWtServer ?? isWtServer;
  const kill = deps.killPort ?? killPort;
  const spawn = deps.spawnServer ?? spawnServer;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const baseUrl = `http://localhost:${opts.port}`;

  if ((await fv(baseUrl)) === WT_PROTOCOL_VERSION) {
    return { baseUrl, replaced: false }; // current server already up — reuse it
  }

  // Not current. If an older wt-server holds the port, replace it.
  let replaced = false;
  if (await isWt(baseUrl)) {
    await kill(opts.port); // waits until the port is actually free
    replaced = true;
  }

  const spawned = spawn(opts.port, opts.serverEntry);
  for (let i = 0; i < 50; i++) {
    if ((await fv(baseUrl)) === WT_PROTOCOL_VERSION) return { baseUrl, spawned, replaced };
    await sleep(100);
  }
  throw new Error("wt-server did not come up");
}
