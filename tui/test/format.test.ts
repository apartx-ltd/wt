import { test, expect } from "bun:test";
import { statusDot, uptime } from "../src/format";

test("statusDot maps status to glyph+color", () => {
  expect(statusDot("up").glyph).toBe("●");
  expect(statusDot("down").glyph).toBe("○");
  expect(statusDot("building").glyph).toBe("◍");
});

test("uptime formats seconds since started", () => {
  const now = 10_000;
  expect(uptime(now - 30, now)).toBe("30s");
  expect(uptime(now - 120, now)).toBe("2m");
  expect(uptime(null, now)).toBe("");
});
