import { render } from "@opentui/solid";
import { HttpWtClient } from "#shared";
import { packageRoot, resolveOrch, webBuildDir } from "#core";
import { resolve } from "node:path";
import { App } from "../src/app";
import { ensureServer } from "../src/server-boot";

// Launched by `wt ui` (cli/src/dashboards.ts), which passes the workspace as WT_ORCH.
const PORT = Number(process.env.WT_SERVER_PORT ?? 4499);

// staticDir too: a daemon started here is then also fit for `wt web` to reuse.
const { baseUrl, spawned } = await ensureServer({
  port: PORT,
  serverEntry: resolve(packageRoot(), "server/src/index.ts"),
  orch: resolveOrch(),
  staticDir: webBuildDir(),
});
// Kill the server we spawned when the TUI exits, so a stale build can't linger on
// the port and get reused (with outdated routes) by the next `wt ui`.
if (spawned) process.on("exit", () => spawned.kill());

const client = new HttpWtClient(baseUrl);
await render(() => <App client={client} />);
// opentui restores the terminal on these signals but keeps the process alive; exit after
// it (listeners run in registration order) so `wt ui` and the daemon go down with it.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => process.exit(0));
