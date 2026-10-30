import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  DEPS_STAMP,
  depsHash,
  depsVerdict,
  formatDepsStamp,
  parseVolumeProbe,
  ensureHostDeps,
} from "../src/deps";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(resolve(tmpdir(), "wt-deps-"));
  await writeFile(resolve(dir, "package.json"), `{"dependencies":{"svelte":"^5.57.2"}}`);
  await writeFile(resolve(dir, "package-lock.json"), `{"packages":{"node_modules/svelte":{"version":"5.57.2"}}}`);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("depsHash стабилен и меняется вместе с lock", async () => {
  const a = await depsHash(dir);
  expect(await depsHash(dir)).toBe(a);
  await writeFile(resolve(dir, "package-lock.json"), `{"packages":{"node_modules/svelte":{"version":"5.56.2"}}}`);
  expect(await depsHash(dir)).not.toBe(a);
});

test("depsHash: имя файла входит в хеш — то же содержимое в другом файле не совпадает", async () => {
  const a = await depsHash(dir);
  const lock = await readFile(resolve(dir, "package-lock.json"));
  await rm(resolve(dir, "package-lock.json"));
  await writeFile(resolve(dir, "npm-shrinkwrap.json"), lock);
  expect(await depsHash(dir)).not.toBe(a);
});

test("depsVerdict: пусто → empty, без отпечатка → stale, совпал до/после установки → ok", () => {
  expect(depsVerdict({ empty: true, stamp: null }, "h1")).toBe("empty");
  expect(depsVerdict({ empty: false, stamp: null }, "h1")).toBe("stale");
  expect(depsVerdict({ empty: false, stamp: "h0\n" }, "h1")).toBe("stale");
  const stamp = formatDepsStamp("committed", "drifted");
  expect(depsVerdict({ empty: false, stamp }, "committed")).toBe("ok");
  expect(depsVerdict({ empty: false, stamp }, "drifted")).toBe("ok");
  expect(formatDepsStamp("same", "same")).toBe("same\n");
});

test("parseVolumeProbe: пустой том, том без отпечатка, том с отпечатком", () => {
  expect(parseVolumeProbe("")).toEqual({ empty: true, stamp: null });
  expect(parseVolumeProbe(".bin\n")).toEqual({ empty: false, stamp: null });
  expect(parseVolumeProbe(`.bin\nh0\nh1\n`)).toEqual({ empty: false, stamp: "h0\nh1" });
});

// Фейковый install: считает запуски и создаёт node_modules, как настоящий.
const fakeInstall = () => ["sh", "-c", "mkdir -p node_modules && echo x >> installs.log"];
const installs = async () => (existsSync(resolve(dir, "installs.log")) ? (await readFile(resolve(dir, "installs.log"), "utf8")).split("\n").filter(Boolean).length : 0);

test("ensureHostDeps: ставит в пустой, пропускает свежий, переустанавливает при смене lock", async () => {
  await ensureHostDeps(dir, fakeInstall());
  expect(await installs()).toBe(1);
  expect(existsSync(resolve(dir, "node_modules", DEPS_STAMP))).toBe(true);

  await ensureHostDeps(dir, fakeInstall());
  expect(await installs()).toBe(1);

  await writeFile(resolve(dir, "package-lock.json"), `{"packages":{"node_modules/svelte":{"version":"5.58.0"}}}`);
  await ensureHostDeps(dir, fakeInstall());
  expect(await installs()).toBe(2);
});

test("ensureHostDeps: node_modules без отпечатка (поставлен до проверки) переустанавливается один раз", async () => {
  await Bun.spawn(["mkdir", "-p", resolve(dir, "node_modules")]).exited;
  await ensureHostDeps(dir, fakeInstall());
  expect(await installs()).toBe(1);
  await ensureHostDeps(dir, fakeInstall());
  expect(await installs()).toBe(1);
});

test("ensureHostDeps: install, переписавший lock, и последующий откат lock — без повторной установки", async () => {
  const committed = await readFile(resolve(dir, "package-lock.json"), "utf8");
  const drift = ["sh", "-c", `mkdir -p node_modules && echo x >> installs.log && echo '{"lockfileVersion":3}' > package-lock.json`];
  await ensureHostDeps(dir, drift);
  expect(await installs()).toBe(1);
  await ensureHostDeps(dir, fakeInstall());
  expect(await installs()).toBe(1);
  await writeFile(resolve(dir, "package-lock.json"), committed);
  await ensureHostDeps(dir, fakeInstall());
  expect(await installs()).toBe(1);
});
