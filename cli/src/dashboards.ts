// `wt ui` and `wt web`: the CLI launches both dashboards itself (no shell wrapper).
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageRoot, resolveOrch } from "#core";
import { ensureServer } from "../../tui/src/server-boot";

/**
 * argv for the TUI child. The Solid JSX transform needs `@opentui/solid/preload`, and Bun
 * reads `bunfig.toml` from the cwd only — so for a user running `wt` from their workspace
 * the package's own bunfig never applies. The preload is passed explicitly, by absolute path.
 */
export function tuiSpawnArgv(root = packageRoot()): string[] {
  const preload = fileURLToPath(import.meta.resolve("@opentui/solid/preload"));
  return [process.execPath, "--preload", preload, resolve(root, "tui/bin/wt-ui.tsx")];
}

/**
 * Run the full-screen TUI in the foreground and return its exit code. `orch` reaches the
 * TUI as WT_ORCH, which binds the wt-server it starts to this workspace.
 */
export async function runTui(extra: string[], opts: { orch?: string } = {}): Promise<number> {
  const env = opts.orch ? { ...process.env, WT_ORCH: opts.orch } : process.env;
  const proc = Bun.spawn(tuiSpawnArgv().concat(extra), {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env,
  });
  return proc.exited;
}

/** The built web dashboard (`bun run build:web`), served by wt-server itself. */
export function webBuildDir(root = packageRoot()): string {
  return resolve(root, "web/build");
}

/**
 * `wt web`: ensure a wt-server bound to the workspace and serving the built dashboard,
 * print its URL and wait for Ctrl-C. `dev` instead runs the SvelteKit dev server in
 * `web/`, which proxies same-origin /api to WT_SERVER_PORT (see web/vite.config.ts).
 */
export async function runWeb(opts: { dev: boolean; root?: string; orch?: string }): Promise<number> {
  const root = opts.root ?? packageRoot();
  const port = Number(process.env.WT_SERVER_PORT ?? 4499);
  const staticDir = webBuildDir(root);
  if (!opts.dev && !existsSync(resolve(staticDir, "index.html"))) {
    process.stderr.write(
      "wt web: dashboard is not built — run `bun run build:web` in the wt checkout, or use `wt web --dev`\n",
    );
    return 1;
  }

  const { baseUrl, spawned, replaced } = await ensureServer({
    port,
    serverEntry: resolve(root, "server/src/index.ts"),
    orch: opts.orch ?? resolveOrch(),
    staticDir,
  });
  // Only kill a server WE spawned — a pre-existing one belongs to another session.
  const killSpawned = () => {
    try {
      spawned?.kill();
    } catch {
      /* already gone */
    }
  };

  if (opts.dev) return runViteDev({ root, port, baseUrl, replaced, killSpawned });

  console.log(`wt web: ${baseUrl}`);
  await new Promise<void>((done) => {
    const keepAlive = setInterval(() => {}, 1 << 30); // a reused server leaves nothing else to wait on
    const onSignal = () => {
      clearInterval(keepAlive);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      done();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
  killSpawned();
  return 0;
}

/** `wt web --dev`: the SvelteKit dev server in `web/` until it exits or Ctrl-C. */
async function runViteDev(o: {
  root: string;
  port: number;
  baseUrl: string;
  replaced: boolean;
  killSpawned: () => void;
}): Promise<number> {
  const { root, port, baseUrl, replaced, killSpawned } = o;
  const webPort = Number(process.env.WT_WEB_PORT ?? 5199);
  console.log(`wt-server: ${baseUrl}${replaced ? " (replaced stale)" : ""}`);
  console.log(`wt web:    http://localhost:${webPort}`);

  const vite = Bun.spawn([process.execPath, "run", "dev", "--", "--port", String(webPort)], {
    cwd: resolve(root, "web"),
    env: { ...process.env, WT_SERVER_PORT: String(port) },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const cleanup = () => {
    try {
      vite.kill();
    } catch {
      /* already gone */
    }
    killSpawned();
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => (cleanup(), process.exit(0)));
  process.on("SIGTERM", () => (cleanup(), process.exit(0)));

  const code = await vite.exited;
  cleanup();
  return code;
}
