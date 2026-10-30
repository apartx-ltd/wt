import { render } from "@opentui/solid";
import { HttpWtClient } from "#shared";
import { App } from "../src/app";
import { ensureServer } from "../src/server-boot";

const PORT = Number(process.env.WT_SERVER_PORT ?? 4499);
const serverEntry = new URL("../../server/src/index.ts", import.meta.url).pathname;

const { baseUrl, spawned } = await ensureServer({ port: PORT, serverEntry });
// Kill the server we spawned when the TUI exits, so a stale build can't linger on
// the port and get reused (with outdated routes) by the next `wt ui`.
if (spawned) process.on("exit", () => spawned.kill());

const client = new HttpWtClient(baseUrl);
await render(() => <App client={client} />);
