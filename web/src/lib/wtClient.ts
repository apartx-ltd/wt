import { HttpWtClient } from "#shared";

/**
 * Browser-side wt-server client. Base URL is same-origin ("") by default — Vite
 * proxies `/api` to the local wt-server in dev (see vite.config.ts), so there's
 * no CORS and SSE streams straight through. Override with `PUBLIC_WT_URL` to
 * point at a server on another host/port.
 *
 * Construct lazily (only in the browser) — the wt-server may not be up during
 * SSR, and the dashboard is a live client view anyway.
 */
let client: HttpWtClient | undefined;

export function getWtClient(): HttpWtClient {
  if (!client) {
    const base = import.meta.env.PUBLIC_WT_URL ?? "";
    client = new HttpWtClient(base);
  }
  return client;
}
