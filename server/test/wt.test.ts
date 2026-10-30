import { test, expect } from "bun:test";
import { runWt, spawnWtLines, streamLines, childEnv } from "../src/wt";

const STUB = new URL("./fixtures/wt-stub.sh", import.meta.url).pathname;

test("childEnv drops PORT so the daemon's port can't leak into a spawned wt", () => {
  const env = childEnv({ PORT: "4499", PATH: "/usr/bin", HOME: "/home/x" });
  expect(env.PORT).toBeUndefined();
  expect(env.PATH).toBe("/usr/bin");
  expect(env.HOME).toBe("/home/x");
});

test("childEnv does not mutate the input env", () => {
  const base = { PORT: "4499", FOO: "bar" };
  childEnv(base);
  expect(base.PORT).toBe("4499");
});

test("runWt returns code + output without throwing on non-zero", async () => {
  const ok = await runWt(["stop", "apartx-server", "main"], { wtBin: STUB });
  expect(ok.code).toBe(0);
  expect(ok.stdout).toContain("stopped apartx-server main");

  const bad = await runWt(["bogus"], { wtBin: STUB });
  expect(bad.code).toBe(2);
  expect(bad.stderr).toContain("unexpected argv");
});

test("spawnWtLines + streamLines yield log lines", async () => {
  const proc = spawnWtLines(["logs", "apartx-server", "main", "-f"], { wtBin: STUB });
  const lines: string[] = [];
  for await (const line of streamLines(proc.stdout as ReadableStream<Uint8Array>)) lines.push(line);
  expect(lines).toEqual(["=> App running", "mongo connected"]);
});

test("streamLines reassembles lines across chunk boundaries", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      c.enqueue(enc.encode("alpha\nbe"));
      c.enqueue(enc.encode("ta\r\ngamma")); // CRLF + trailing partial line
      c.close();
    },
  });
  const lines: string[] = [];
  for await (const line of streamLines(stream)) lines.push(line);
  expect(lines).toEqual(["alpha", "beta", "gamma"]);
});
