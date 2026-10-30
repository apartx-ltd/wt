import { test, expect } from "bun:test";
import { instancesChanged } from "../src/poller";
import type { MergedInstance } from "#shared";

const inst = (over: Partial<MergedInstance> = {}): MergedInstance => ({
  project: "p", slug: "s", branch: "feature/s", port: 4000,
  status: "up", pid: 1, container: null, started: 0, ...over,
});

test("identical snapshots are unchanged", () => {
  expect(instancesChanged([inst()], [inst()])).toBe(false);
});

test("status flip is a change", () => {
  expect(instancesChanged([inst({ status: "up" })], [inst({ status: "down" })])).toBe(true);
});

test("different length is a change", () => {
  expect(instancesChanged([inst()], [])).toBe(true);
});
