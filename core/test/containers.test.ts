import { test, expect } from "bun:test";
import { containerName, isDockerRemoveOk, dockerRemove, dockerPs, type DockerExec } from "../src/containers";

test("containerName: префикс wtdev-", () => {
  expect(containerName("apartx-cabinet", "gateway-qr")).toBe("wtdev-apartx-cabinet-gateway-qr");
});

test("isDockerRemoveOk: код 0 — успех", () => {
  expect(isDockerRemoveOk({ code: 0, stderr: "" })).toBe(true);
});

test("isDockerRemoveOk: код 0 со stderr про отсутствующий контейнер — успех", () => {
  // современный docker: `docker rm -f <нет такого>` пишет в stderr, но выходит с 0
  expect(isDockerRemoveOk({ code: 0, stderr: "Error response from daemon: No such container: wtdev-x" })).toBe(true);
});

test("isDockerRemoveOk: ненулевой код с «No such container» — успех (контейнера уже нет)", () => {
  expect(isDockerRemoveOk({ code: 1, stderr: "Error: No such container: wtdev-x" })).toBe(true);
});

test("isDockerRemoveOk: недоступный демон — не успех", () => {
  expect(isDockerRemoveOk({ code: 1, stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock." })).toBe(false);
});

test("dockerRemove: успех → docker rm -f <ids…> и без броска", async () => {
  const calls: string[][] = [];
  const exec: DockerExec = async (argv) => (calls.push(argv), { code: 0, stderr: "" });
  await dockerRemove(["wtdev-a", "wtdev-b"], exec);
  expect(calls).toEqual([["rm", "-f", "wtdev-a", "wtdev-b"]]);
});

test("dockerRemove: ненулевой код → ошибка с текстом stderr от docker", async () => {
  const exec: DockerExec = async () => ({
    code: 1,
    stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
  });
  const err = await dockerRemove(["wtdev-apartx-cabinet-gateway-qr"], exec).then(
    () => null,
    (e: Error) => e,
  );
  expect(err).toBeInstanceOf(Error);
  expect(err!.message).toContain("Cannot connect to the Docker daemon");
  expect(err!.message).toContain("wtdev-apartx-cabinet-gateway-qr");
});

test("dockerRemove: пустой stderr → в ошибке хотя бы код возврата", async () => {
  const exec: DockerExec = async () => ({ code: 125, stderr: "" });
  const err = await dockerRemove(["wtdev-x"], exec).then(
    () => null,
    (e: Error) => e,
  );
  expect(err!.message).toContain("125");
});

test("dockerRemove: «нет такого контейнера» не считается ошибкой", async () => {
  const exec: DockerExec = async () => ({ code: 1, stderr: "Error: No such container: wtdev-x" });
  expect(await dockerRemove(["wtdev-x"], exec).then(() => "ok")).toBe("ok");
});

test("dockerPs: ненулевой код → ошибка (пустой список неотличим от «не смог спросить»)", async () => {
  const exec: DockerExec = async () => ({ code: 1, stderr: "Cannot connect to the Docker daemon" });
  const err = await dockerPs(["--filter", "name=wtdev-"], exec).then(
    () => null,
    (e: Error) => e,
  );
  expect(err!.message).toContain("Cannot connect to the Docker daemon");
});

test("dockerPs: код 0 → построчный список без пустых строк", async () => {
  const calls: string[][] = [];
  const exec: DockerExec = async (argv) => (calls.push(argv), { code: 0, stderr: "", stdout: "wtdev-a\nwtdev-b\n" });
  expect(await dockerPs(["-aq", "--filter", "name=wtdev-"], exec)).toEqual(["wtdev-a", "wtdev-b"]);
  expect(calls).toEqual([["ps", "-aq", "--filter", "name=wtdev-"]]);
});

test("dockerPs: пустой вывод → пустой список", async () => {
  const exec: DockerExec = async () => ({ code: 0, stderr: "", stdout: "\n" });
  expect(await dockerPs(["-aq"], exec)).toEqual([]);
});
