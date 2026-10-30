import { resolve } from "node:path";
import { packageRoot } from "#core";

export interface WtOpts {
  /** Override for the wt executable (tests use a stub). Defaults to the package's own CLI. */
  wtBin?: string;
  /** Working directory (orchestrator root). */
  cwd?: string;
}

/** Spawn-array prefix for the wt CLI: the package's own `cli/bin/wt.ts` run by the current bun. */
export function resolveBin(opts: WtOpts): string[] {
  if (opts.wtBin) return [opts.wtBin];
  return [process.execPath, resolve(packageRoot(), "cli/bin/wt.ts")];
}

/**
 * Env for the spawned wt CLI: inherit the daemon's env but DROP `PORT`. The wt-server is
 * launched with `PORT=<its own port>` (e.g. 4499, see server-boot `spawnServer`). Without
 * stripping it that leaks into `wt start`, and dotenvx won't override an already-set
 * `PORT`, so a host-process instance (apartx-spaces/pdf/images/…) would try to bind the
 * server's port instead of its worktree/base `.env` PORT — "Can't listen on port 4499".
 * Dockerized instances set container env explicitly, which is why only host procs broke.
 */
export function childEnv(
  base: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const env = { ...base };
  delete env.PORT;
  return env;
}

/**
 * Run the wt CLI to completion and capture its output. Does NOT throw on a non-zero
 * exit — the caller inspects `code` (used for the fast `wt stop`, where the exit code
 * is the result we report to the client). The CLI is the package's own `cli/bin/wt.ts`
 * (→ `#core`), so this is a subprocess boundary, not a bash call.
 * Read-only snapshots (list/ps/projects) skip the subprocess entirely — the server
 * reads them in-process via `@wt/core` (see index.ts); only mutations spawn the CLI here.
 */
export async function runWt(
  args: string[],
  opts: WtOpts = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([...resolveBin(opts), ...args], {
    cwd: opts.cwd,
    env: childEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/**
 * Spawn the wt CLI detached and return immediately. `start`/`restart` block until the
 * dev server's port is up (a Meteor build can take minutes); the daemon must not block
 * its event loop on that, so it forks the CLI (cli/bin/wt.ts → #core) as a
 * fire-and-forget child that owns the long-running lifecycle.
 */
export function spawnWtDetached(args: string[], opts: WtOpts = {}): void {
  Bun.spawn([...resolveBin(opts), ...args], {
    cwd: opts.cwd,
    env: childEnv(),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
}

/** Spawn wt with stdout piped, for streaming (e.g. `wt logs -f`). Caller kills it. */
export function spawnWtLines(args: string[], opts: WtOpts = {}): Bun.Subprocess {
  return Bun.spawn([...resolveBin(opts), ...args], {
    cwd: opts.cwd,
    env: childEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** Yield complete lines from a byte stream (handles chunk boundaries + CRLF). */
export async function* streamLines(
  readable: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        yield line;
      }
    }
    if (buf.length > 0) yield buf; // trailing partial line
  } finally {
    reader.releaseLock();
  }
}
