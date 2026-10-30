import { test, expect, beforeAll, afterAll } from "bun:test";
import { resolveOrch, packageRoot, WorkspaceNotFoundError } from "../src/orch";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

let root: string;
let bare: string;

beforeAll(() => {
  root = mkdtempSync(resolve(tmpdir(), "wt-orch-"));
  writeFileSync(resolve(root, "wt.config.ts"), "");
  mkdirSync(resolve(root, "a", "b"), { recursive: true });
  bare = mkdtempSync(resolve(tmpdir(), "wt-orch-bare-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
});

test("resolveOrch walks up from cwd to the first directory holding wt.config.ts", () => {
  expect(resolveOrch({}, resolve(root, "a", "b"))).toBe(realpathSync.native(root));
});

test("resolveOrch returns cwd itself when wt.config.ts is right there", () => {
  expect(resolveOrch({}, root)).toBe(realpathSync.native(root));
});

test("resolveOrch throws WorkspaceNotFoundError when no wt.config.ts is found up to the filesystem root", () => {
  expect(() => resolveOrch({}, bare)).toThrow(WorkspaceNotFoundError);
  expect(() => resolveOrch({}, bare)).toThrow(
    `no wt.config.ts found in ${bare} or any parent directory (create one at the workspace root, or set WT_ORCH)`,
  );
});

test("resolveOrch prefers WT_ORCH over the upward search", () => {
  expect(resolveOrch({ WT_ORCH: "/tmp/x" }, resolve(root, "a", "b"))).toBe("/tmp/x");
  expect(resolveOrch({ WT_ORCH: "/tmp/x" }, bare)).toBe("/tmp/x");
});

test("resolveOrch canonicalizes path case (cd ~/projects/apartx on a case-insensitive filesystem)", () => {
  const found = resolveOrch({}, resolve(root, "a"));
  const swapped = found.replace(/[A-Za-z](?=[^/]*$)/, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()));
  if (!existsSync(swapped)) return; // case-sensitive filesystem — the case does not arise
  expect(resolveOrch({ WT_ORCH: swapped }, bare)).toBe(found);
  expect(resolveOrch({}, resolve(swapped, "a", "b"))).toBe(found);
});

test("packageRoot is the @apartx/wt package directory", () => {
  const pkgRoot = packageRoot();
  expect(existsSync(resolve(pkgRoot, "cli", "bin", "wt.ts"))).toBe(true);
  expect(require(resolve(pkgRoot, "package.json")).name).toBe("@apartx/wt");
});
