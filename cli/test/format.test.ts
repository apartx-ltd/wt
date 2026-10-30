import { test, expect } from "bun:test";
import { col, fmtUptime, stopLine } from "../src/format";

const outcome = (over: Partial<Parameters<typeof stopLine>[2]> = {}) => ({
  project: "apartx-cabinet",
  slug: "gateway-qr",
  action: "container" as const,
  container: "wtdev-apartx-cabinet-gateway-qr",
  pid: null,
  error: null,
  ...over,
});

test("stopLine: container removed → ok + \"stopped\"", () => {
  expect(stopLine("apartx-cabinet", "gateway-qr", outcome())).toEqual({
    ok: true,
    text: "stopped apartx-cabinet/gateway-qr (container wtdev-apartx-cabinet-gateway-qr)",
  });
});

test("stopLine: container NOT removed → not ok and without the word \"stopped\"", () => {
  const r = stopLine("apartx-cabinet", "gateway-qr", outcome({ error: "docker rm -f …: Cannot connect to the Docker daemon" }));
  expect(r.ok).toBe(false);
  expect(r.text).not.toContain("stopped");
  expect(r.text).toContain("apartx-cabinet/gateway-qr");
  expect(r.text).toContain("Cannot connect to the Docker daemon");
});

test("stopLine: host pid and cleanup", () => {
  expect(stopLine("apartx-help", "x", outcome({ action: "pid", container: null, pid: 4242 })).text).toBe(
    "stopped apartx-help/x (PID 4242)",
  );
  expect(stopLine("apartx-help", "x", outcome({ action: "cleanup", container: null })).text).toContain("cleaned up the runfile");
});

test("col pads right to width (printf %-Ns), no truncation", () => {
  expect(col("ab", 4)).toBe("ab  ");
  expect(col("abcdef", 4)).toBe("abcdef"); // longer than the width — no truncation (like printf)
});

test("fmtUptime: s / m / h+m buckets (parity with fmt_uptime)", () => {
  const now = 1000;
  expect(fmtUptime(now - 5, now)).toBe("5s");
  expect(fmtUptime(now - 120, now)).toBe("2m");
  expect(fmtUptime(now - 3720, now)).toBe("1h2m");
  expect(fmtUptime(now + 10, now)).toBe("0s"); // negative → 0
});
