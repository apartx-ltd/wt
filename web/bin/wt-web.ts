// `wt web` entry: ensure a current wt-server is up (same version-checked path as
// `wt ui` — reuses ensureServer so a stale build holding the port gets replaced),
// then launch the SvelteKit dev server. The web app talks same-origin /api, which
// Vite proxies to WT_SERVER_PORT (see vite.config.ts).
import { ensureServer } from "../../tui/src/server-boot";

const PORT = Number(process.env.WT_SERVER_PORT ?? 4499);
const WEB_PORT = Number(process.env.WT_WEB_PORT ?? 5199);
const serverEntry = new URL("../../server/src/index.ts", import.meta.url).pathname;
const webDir = new URL("..", import.meta.url).pathname; // tools/wt/web

const { baseUrl, spawned, replaced } = await ensureServer({ port: PORT, serverEntry });
console.log(`wt-server: ${baseUrl}${replaced ? " (replaced stale)" : ""}`);
console.log(`wt web:    http://localhost:${WEB_PORT}`);

const vite = Bun.spawn(["bun", "run", "dev", "--", "--port", String(WEB_PORT)], {
  cwd: webDir,
  env: { ...process.env, WT_SERVER_PORT: String(PORT) },
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
  // Only kill a server WE spawned — a pre-existing one belongs to another session.
  if (spawned) {
    try {
      spawned.kill();
    } catch {
      /* already gone */
    }
  }
};
process.on("exit", cleanup);
process.on("SIGINT", () => (cleanup(), process.exit(0)));
process.on("SIGTERM", () => (cleanup(), process.exit(0)));

await vite.exited;
cleanup();
