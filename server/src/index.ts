import { mergeInstances, WT_PROTOCOL_VERSION, type MergedInstance, type Worktree, type RunInstance, type BaseSpec } from "#shared";
import { resolveOrch, listWorktrees, listRunningInstances, listProjects, loadConfig, resolveProjectsDir, projectDir, resolveBasePort, gitBranch } from "#core";
import { basename } from "node:path";
import { runWt, spawnWtDetached, spawnWtLines, streamLines, type WtOpts } from "./wt";
import { instancesChanged } from "./poller";

export interface ServerOpts extends WtOpts {
  port?: number;
  pollMs?: number;
  /** Orchestrator root for core reads. Default: resolveOrch() (WT_ORCH env / wt.config.ts upward from cwd). */
  orch?: string;
  /** Test seams — override the read providers; default to direct `@wt/core` calls. */
  readWorktrees?: () => Promise<Worktree[]>;
  readRunning?: () => Promise<RunInstance[]>;
  readBases?: () => Promise<BaseSpec[]>;
  readProjects?: () => Promise<string[]>;
  /** Workspace title for /api/meta; default loads `wt.config` title (null if unset/no config). */
  readTitle?: () => Promise<string | null>;
}

/** Resolve the read providers, defaulting to direct core reads against `orch`. */
function readers(opts: ServerOpts) {
  const orch = opts.orch ?? resolveOrch();
  const readWorktrees = opts.readWorktrees ?? (() => listWorktrees(orch));
  const readRunning = opts.readRunning ?? (() => listRunningInstances(orch));
  const readBases = opts.readBases ?? (async (): Promise<BaseSpec[]> => {
    const projectsDir = await resolveProjectsDir(orch);
    const projects = await listProjects(orch);
    return Promise.all(projects.map(async (project) => {
      const dir = projectDir(orch, project, projectsDir);
      return { project, branch: await gitBranch(dir), port: await resolveBasePort(dir) };
    }));
  });
  const readProjects = opts.readProjects ?? (() => listProjects(orch));
  const readTitle =
    opts.readTitle ??
    (async () => {
      try {
        return (await loadConfig(orch, basename(orch))).title ?? null;
      } catch {
        return null;
      }
    });
  // mergeInstances still runs here, so the up/down logic is exercised against live data.
  const snapshot = async (): Promise<MergedInstance[]> =>
    mergeInstances(...(await Promise.all([readWorktrees(), readRunning(), readBases()])));
  return { snapshot, readProjects, readTitle };
}

// SSE wire format: the `event:` name is the discriminant, `data` is the bare payload
// (an instances array, or {message} for errors). The client reconstructs a `WtEvent`
// object from the event name + payload — so `data` is NOT a full WtEvent envelope.
function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createServer(opts: ServerOpts = {}) {
  const pollMs = opts.pollMs ?? 1500;
  const { snapshot, readProjects, readTitle } = readers(opts);

  return Bun.serve({
    port: opts.port ?? 4499,
    async fetch(req) {
      const url = new URL(req.url);

      // Health/version — clients use this to detect & replace a stale server (see
      // WT_PROTOCOL_VERSION). Must stay a trivial, always-present route.
      if (url.pathname === "/api/health") {
        return Response.json({ version: WT_PROTOCOL_VERSION });
      }

      // Workspace metadata (configurable title) → frontends render `wt · <title>`.
      if (url.pathname === "/api/meta") {
        return Response.json({ title: await readTitle() });
      }

      if (url.pathname === "/api/instances") {
        try {
          return Response.json(await snapshot());
        } catch (e) {
          return Response.json({ error: String(e) }, { status: 500 });
        }
      }

      if (url.pathname === "/api/projects") {
        try {
          return Response.json(await readProjects());
        } catch (e) {
          return Response.json({ error: String(e) }, { status: 500 });
        }
      }

      // Create worktree: long-blocking (meteor npm install) → fire-and-forget.
      if (url.pathname === "/api/worktrees" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as {
          project?: string; slug?: string; isolatedDb?: boolean; seed?: boolean;
        };
        if (!body.project || !body.slug) {
          return Response.json({ error: "project and slug are required" }, { status: 400 });
        }
        const flags = [
          ...(body.isolatedDb ? ["--isolated-db"] : []),
          ...(body.seed ? ["--seed"] : []),
        ];
        spawnWtDetached(["new", body.project, body.slug, ...flags], opts);
        return Response.json({ ok: true }, { status: 202 });
      }

      // Remove worktree: DELETE /api/worktrees/:project/:slug[?branch=1]
      const rm = url.pathname.match(/^\/api\/worktrees\/([^/]+)\/([^/]+)$/);
      if (rm && req.method === "DELETE") {
        const [, project, slug] = rm;
        const flags = url.searchParams.get("branch") ? ["--branch"] : [];
        const { code, stderr } = await runWt(["rm", project, slug, ...flags], opts);
        return Response.json({ code, stderr: stderr.trim() || undefined });
      }

      // Instance actions + log follow: /api/instances/:project/:slug/(start|stop|restart|logs|link|unlink)
      const action = url.pathname.match(/^\/api\/instances\/([^/]+)\/([^/]+)\/(start|stop|restart|logs|link|unlink)$/);
      if (action) {
        const [, project, slug, kind] = action;

        if (kind === "logs" && req.method === "GET") {
          let proc: ReturnType<typeof spawnWtLines> | undefined;
          const stream = new ReadableStream({
            async start(controller) {
              const enc = new TextEncoder();
              proc = spawnWtLines(["logs", project, slug, "-f"], opts);
              try {
                for await (const line of streamLines(proc.stdout as ReadableStream<Uint8Array>)) {
                  controller.enqueue(enc.encode(sse("log", line)));
                }
              } catch {
                /* client aborted or process killed */
              }
            },
            cancel() { proc?.kill(); },
          });
          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          });
        }

        if (kind === "stop" && req.method === "POST") {
          const { code, stderr } = await runWt(["stop", project, slug], opts);
          return Response.json({ code, stderr: stderr.trim() || undefined });
        }

        if ((kind === "start" || kind === "restart") && req.method === "POST") {
          // start/restart block in bash until the port is up — fire and forget.
          spawnWtDetached([kind, project, slug], opts);
          return Response.json({ ok: true }, { status: 202 });
        }

        if (kind === "link" && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as { linkSlug?: string };
          const args = ["link", project, slug, ...(body.linkSlug ? [body.linkSlug] : [])];
          const { code, stderr } = await runWt(args, opts);
          return Response.json({ code, stderr: stderr.trim() || undefined });
        }

        if (kind === "unlink" && req.method === "POST") {
          const { code, stderr } = await runWt(["unlink", project, slug], opts);
          return Response.json({ code, stderr: stderr.trim() || undefined });
        }

        return new Response("method not allowed", { status: 405 });
      }

      if (url.pathname === "/api/events") {
        let timer: ReturnType<typeof setInterval> | undefined;
        const stream = new ReadableStream({
          async start(controller) {
            const enc = new TextEncoder();
            let prev: MergedInstance[] = [];
            let pushedOnce = false;
            const tick = async () => {
              try {
                const next = await snapshot();
                // Always push the first snapshot (even when empty); then only on change.
                if (!pushedOnce || instancesChanged(prev, next)) {
                  prev = next;
                  pushedOnce = true;
                  controller.enqueue(enc.encode(sse("instances", next)));
                }
              } catch (e) {
                controller.enqueue(enc.encode(sse("error", { message: String(e) })));
              }
            };
            await tick(); // initial push (unconditional)
            timer = setInterval(tick, pollMs);
          },
          cancel() { if (timer !== undefined) clearInterval(timer); },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      return new Response("not found", { status: 404 });
    },
  });
}

// Direct run: `bun src/index.ts`
if (import.meta.main) {
  const server = createServer({ port: Number(process.env.PORT ?? 4499) });
  console.log(`wt-server on http://localhost:${server.port}`);
}
