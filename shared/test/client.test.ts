import { test, expect, afterAll } from "bun:test";
import { HttpWtClient } from "../src/client";
import type { MergedInstance } from "../src/types";

const sample: MergedInstance[] = [
  { project: "p", slug: "s", branch: "feature/s", port: 4000,
    status: "up", pid: 1, container: null, started: 0 },
];

// SSE endpoint mirrors the real server wire format: `event:`/`data:` with a
// leading space after the colon (per the SSE spec), terminated by a blank line.
function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const srv = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/api/instances") return Response.json(sample);
    if (path === "/api/events") {
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          // Split one event across two chunks to exercise buffering.
          controller.enqueue(enc.encode("event: instances\nda"));
          controller.enqueue(enc.encode(`ta: ${JSON.stringify(sample)}\n\n`));
          controller.enqueue(enc.encode(sse("error", { message: "boom" })));
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    }
    if (req.method === "POST" && path === "/api/instances/p/s/start")
      return Response.json({ ok: true }, { status: 202 });
    if (req.method === "POST" && path === "/api/instances/p/s/restart")
      return Response.json({ ok: true }, { status: 202 });
    if (req.method === "POST" && path === "/api/instances/p/s/stop")
      return Response.json({ code: 0 });
    if (req.method === "GET" && path === "/api/projects")
      return Response.json(["apartx-server", "apartx-cabinet"]);
    if (req.method === "POST" && path === "/api/worktrees")
      return Response.json({ ok: true }, { status: 202 });
    if (req.method === "DELETE" && path === "/api/worktrees/p/s")
      return Response.json({ code: 0 });
    if (req.method === "POST" && path === "/api/instances/p/s/link")
      return Response.json({ code: 0 });
    if (req.method === "POST" && path === "/api/instances/p/s/unlink")
      return Response.json({ code: 0 });
    if (req.method === "GET" && path === "/api/instances/p/s/logs") {
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          // Split a log frame across chunks to exercise buffering.
          controller.enqueue(enc.encode("event: log\ndata: "));
          controller.enqueue(enc.encode(`${JSON.stringify("line one")}\n\n`));
          controller.enqueue(enc.encode(sse("log", "line two")));
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response("nope", { status: 404 });
  },
});
afterAll(() => srv.stop(true));

test("listInstances() fetches and parses", async () => {
  const client = new HttpWtClient(`http://localhost:${srv.port}`);
  const list = await client.listInstances();
  expect(list[0].slug).toBe("s");
  expect(list[0].status).toBe("up");
});

test("subscribe() parses SSE events over fetch (no EventSource global needed)", async () => {
  const client = new HttpWtClient(`http://localhost:${srv.port}`);
  const events: unknown[] = [];
  const unsub = client.subscribe((e) => events.push(e));
  // Poll until both events arrive (stream resolves asynchronously).
  for (let i = 0; i < 50 && events.length < 2; i++) await Bun.sleep(20);
  unsub();
  expect(events).toContainEqual({ type: "instances", instances: sample });
  expect(events).toContainEqual({ type: "error", message: "boom" });
});

test("start()/restart() POST and resolve ok", async () => {
  const client = new HttpWtClient(`http://localhost:${srv.port}`);
  expect(await client.start("p", "s")).toEqual({ ok: true });
  expect(await client.restart("p", "s")).toEqual({ ok: true });
});

test("stop() returns the exit code", async () => {
  const client = new HttpWtClient(`http://localhost:${srv.port}`);
  expect(await client.stop("p", "s")).toEqual({ code: 0 });
});

test("streamLogs() yields log lines over SSE", async () => {
  const client = new HttpWtClient(`http://localhost:${srv.port}`);
  const lines: string[] = [];
  const unsub = client.streamLogs("p", "s", (l) => lines.push(l));
  for (let i = 0; i < 50 && lines.length < 2; i++) await Bun.sleep(20);
  unsub();
  expect(lines).toEqual(["line one", "line two"]);
});

test("listProjects() fetches project names", async () => {
  const client = new HttpWtClient(`http://localhost:${srv.port}`);
  expect(await client.listProjects()).toEqual(["apartx-server", "apartx-cabinet"]);
});

test("newWorktree() POSTs and resolves ok", async () => {
  const client = new HttpWtClient(`http://localhost:${srv.port}`);
  expect(await client.newWorktree({ project: "p", slug: "s", isolatedDb: true })).toEqual({ ok: true });
});

test("rmWorktree() / link() / unlink() return exit codes", async () => {
  const client = new HttpWtClient(`http://localhost:${srv.port}`);
  expect(await client.rmWorktree("p", "s", true)).toEqual({ code: 0 });
  expect(await client.link("p", "s", "s")).toEqual({ code: 0 });
  expect(await client.unlink("p", "s")).toEqual({ code: 0 });
});
