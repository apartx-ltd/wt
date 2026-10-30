import type { MergedInstance, WtEvent, WtMeta } from "./types";

export class HttpWtClient {
  constructor(private baseUrl: string) {}

  async listInstances(): Promise<MergedInstance[]> {
    const res = await fetch(`${this.baseUrl}/api/instances`);
    if (!res.ok) throw new Error(`GET /api/instances -> ${res.status}`);
    return res.json() as Promise<MergedInstance[]>;
  }

  /** Workspace metadata (configurable title etc.) for the frontends' chrome. */
  async getMeta(): Promise<WtMeta> {
    const res = await fetch(`${this.baseUrl}/api/meta`);
    if (!res.ok) throw new Error(`GET /api/meta -> ${res.status}`);
    return res.json() as Promise<WtMeta>;
  }

  /** Send a JSON request (default POST) and parse the JSON body; throws on non-2xx. */
  private async send<T>(path: string, method = "POST", body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
    return res.json() as Promise<T>;
  }

  private post<T>(path: string): Promise<T> {
    return this.send<T>(path, "POST");
  }

  /** Project names available to create worktrees in (for the `new` modal). */
  listProjects(): Promise<string[]> {
    return fetch(`${this.baseUrl}/api/projects`).then((r) => {
      if (!r.ok) throw new Error(`GET /api/projects -> ${r.status}`);
      return r.json() as Promise<string[]>;
    });
  }

  /** Create a worktree (fire-and-forget: `wt new` blocks on meteor npm install). */
  newWorktree(args: { project: string; slug: string; isolatedDb?: boolean; seed?: boolean }): Promise<{ ok: boolean }> {
    return this.send("/api/worktrees", "POST", args);
  }

  /** Remove a worktree; `dropBranch` also deletes the feature branch. */
  rmWorktree(project: string, slug: string, dropBranch = false): Promise<{ code: number; stderr?: string }> {
    const q = dropBranch ? "?branch=1" : "";
    return this.send(`/api/worktrees/${project}/${slug}${q}`, "DELETE");
  }

  /** Repoint upstreams at same-slug worktrees (`wt link`). */
  link(project: string, slug: string, linkSlug?: string): Promise<{ code: number; stderr?: string }> {
    return this.send(`/api/instances/${project}/${slug}/link`, "POST", linkSlug ? { linkSlug } : {});
  }

  /** Revert links (`wt unlink`). */
  unlink(project: string, slug: string): Promise<{ code: number; stderr?: string }> {
    return this.send(`/api/instances/${project}/${slug}/unlink`, "POST", {});
  }

  /** Start an instance (fire-and-forget on the server: `wt start` blocks on build). */
  start(project: string, slug: string): Promise<{ ok: boolean }> {
    return this.post(`/api/instances/${project}/${slug}/start`);
  }

  /** Restart an instance (fire-and-forget: `wt restart` = stop+start, blocks). */
  restart(project: string, slug: string): Promise<{ ok: boolean }> {
    return this.post(`/api/instances/${project}/${slug}/restart`);
  }

  /** Stop an instance; the server awaits the (fast) `wt stop` and returns its exit code. */
  stop(project: string, slug: string): Promise<{ code: number; stderr?: string }> {
    return this.post(`/api/instances/${project}/${slug}/stop`);
  }

  /** Subscribe to the instance-status SSE stream. Returns an unsubscribe fn. */
  subscribe(onEvent: (e: WtEvent) => void): () => void {
    return this.streamSse("/api/events", (event, data) => {
      try {
        if (event === "instances") onEvent({ type: "instances", instances: JSON.parse(data) });
        else if (event === "error") onEvent({ type: "error", message: JSON.parse(data).message });
      } catch {
        /* ignore malformed frame */
      }
    });
  }

  /** Stream a `wt logs -f` follow over SSE. Returns an unsubscribe fn. */
  streamLogs(project: string, slug: string, onLine: (line: string) => void): () => void {
    return this.streamSse(`/api/instances/${project}/${slug}/logs`, (event, data) => {
      if (event !== "log") return;
      try {
        onLine(JSON.parse(data));
      } catch {
        /* ignore malformed frame */
      }
    });
  }

  /**
   * Read a Server-Sent Events stream over `fetch` and invoke `onFrame(event, data)`
   * per dispatched frame. Returns an unsubscribe fn (aborts the request).
   *
   * Implemented over `fetch` streaming rather than the `EventSource` global: Bun
   * has no `EventSource`, so constructing one throws `ReferenceError`. When that
   * throw happened inside a Solid `onMount`, it aborted the mount and silently
   * prevented the TUI's keyboard handler from attaching — so this is a
   * deliberate, load-bearing choice, not a stylistic one.
   */
  private streamSse(
    path: string,
    onFrame: (event: string, data: string) => void,
    init?: RequestInit,
  ): () => void {
    const controller = new AbortController();

    (async () => {
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          ...init,
          headers: { Accept: "text/event-stream", ...init?.headers },
          signal: controller.signal,
        });
        if (!res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let event = "message";
        let dataLines: string[] = [];
        const flush = () => {
          if (dataLines.length > 0) onFrame(event, dataLines.join("\n"));
          event = "message";
          dataLines = [];
        };
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            let line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            if (line === "") { flush(); continue; } // blank line dispatches the event
            if (line.startsWith(":")) continue; // comment
            const colon = line.indexOf(":");
            const field = colon === -1 ? line : line.slice(0, colon);
            let val = colon === -1 ? "" : line.slice(colon + 1);
            if (val.startsWith(" ")) val = val.slice(1); // SSE: strip one leading space
            if (field === "event") event = val;
            else if (field === "data") dataLines.push(val);
          }
        }
      } catch {
        /* aborted or stream error — nothing to surface */
      }
    })();

    return () => controller.abort();
  }
}
