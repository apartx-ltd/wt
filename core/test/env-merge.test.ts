import { test, expect } from "bun:test";
import { parseEnvFile, mergeEnvFiles } from "../src/env-merge";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

test("parseEnvFile parses KEY=VALUE, strips surrounding quotes, ignores comments/blanks", () => {
  const m = parseEnvFile(['# comment', 'A=1', 'B="two"', "C='three'", '', 'D=a=b'].join("\n"));
  expect(m.get("A")).toBe("1");
  expect(m.get("B")).toBe("two");
  expect(m.get("C")).toBe("three");
  expect(m.get("D")).toBe("a=b"); // only first '=' splits
  expect(m.has("# comment")).toBe(false);
});

test("parseEnvFile strips a leading `export ` (shell-style .env, e.g. apartx-whatsapp)", () => {
  const m = parseEnvFile([
    'export MONGO_URL=mongodb://localhost:27017/apartx',
    'export AWS_BUCKET="b"',
    'PLAIN=1',
    'export_foo=keep', // no whitespace after "export" → literal key, untouched
  ].join("\n"));
  expect(m.get("MONGO_URL")).toBe("mongodb://localhost:27017/apartx");
  expect(m.get("AWS_BUCKET")).toBe("b");
  expect(m.get("PLAIN")).toBe("1");
  expect(m.get("export_foo")).toBe("keep");
  expect(m.has("export MONGO_URL")).toBe(false);
});

test("mergeEnvFiles layers later files over earlier (later wins); missing files skipped", async () => {
  const d = await mkdtemp(resolve(tmpdir(), "wt-envmerge-"));
  try {
    await writeFile(resolve(d, "base.env"), "PORT=4000\nROOT_URL=http://localhost:4000\nSHARED=base\n");
    await writeFile(resolve(d, "over.env"), "PORT=4010\nSHARED=over\n");
    const merged = await mergeEnvFiles([resolve(d, "base.env"), resolve(d, "missing.env"), resolve(d, "over.env")]);
    expect(merged.PORT).toBe("4010");      // over wins
    expect(merged.ROOT_URL).toBe("http://localhost:4000"); // only in base
    expect(merged.SHARED).toBe("over");
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});
