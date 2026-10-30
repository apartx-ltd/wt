import { test, expect } from "bun:test";
import { resolveOrch } from "../src/orch";
import { existsSync } from "node:fs";

test("resolveOrch prefers WT_ORCH env", () => {
  expect(resolveOrch({ WT_ORCH: "/tmp/x" })).toBe("/tmp/x");
});

test("resolveOrch derives repo root from module path when env absent", () => {
  const root = resolveOrch({});
  expect(root.endsWith("/tools/wt/core/src")).toBe(false);
  expect(root.length).toBeGreaterThan(0);
});

test("resolveOrch канонизирует регистр пути (cd ~/projects/apartx на регистронезависимой ФС)", () => {
  const root = resolveOrch({});
  const swapped = root.replace(/[A-Za-z](?=[^/]*$)/, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()));
  if (!existsSync(swapped)) return; // регистрозависимая ФС — кейса нет
  expect(resolveOrch({ WT_ORCH: swapped })).toBe(root);
});
