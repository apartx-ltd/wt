import { test, expect } from "bun:test";
import { containerName, isDockerRemoveOk, dockerRemove, dockerPs, type DockerExec } from "../src/containers";

test("containerName: wtdev- prefix", () => {
  expect(containerName("apartx-cabinet", "gateway-qr")).toBe("wtdev-apartx-cabinet-gateway-qr");
});

test("isDockerRemoveOk: exit code 0 — success", () => {
  expect(isDockerRemoveOk({ code: 0, stderr: "" })).toBe(true);
});

test("isDockerRemoveOk: exit code 0 with stderr about a missing container — success", () => {
  // modern docker: `docker rm -f <nonexistent>` writes to stderr but exits with 0
  expect(isDockerRemoveOk({ code: 0, stderr: "Error response from daemon: No such container: wtdev-x" })).toBe(true);
});

test("isDockerRemoveOk: non-zero code with \"No such container\" — success (the container is already gone)", () => {
  expect(isDockerRemoveOk({ code: 1, stderr: "Error: No such container: wtdev-x" })).toBe(true);
});

test("isDockerRemoveOk: unreachable daemon — not a success", () => {
  expect(isDockerRemoveOk({ code: 1, stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock." })).toBe(false);
});

test("dockerRemove: success → docker rm -f <ids…> and no throw", async () => {
  const calls: string[][] = [];
  const exec: DockerExec = async (argv) => (calls.push(argv), { code: 0, stderr: "" });
  await dockerRemove(["wtdev-a", "wtdev-b"], exec);
  expect(calls).toEqual([["rm", "-f", "wtdev-a", "wtdev-b"]]);
});

test("dockerRemove: non-zero code → error carrying docker's stderr text", async () => {
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

test("dockerRemove: empty stderr → the error carries at least the exit code", async () => {
  const exec: DockerExec = async () => ({ code: 125, stderr: "" });
  const err = await dockerRemove(["wtdev-x"], exec).then(
    () => null,
    (e: Error) => e,
  );
  expect(err!.message).toContain("125");
});

test("dockerRemove: \"no such container\" is not an error", async () => {
  const exec: DockerExec = async () => ({ code: 1, stderr: "Error: No such container: wtdev-x" });
  expect(await dockerRemove(["wtdev-x"], exec).then(() => "ok")).toBe("ok");
});

test("dockerPs: non-zero code → error (an empty list is indistinguishable from \"could not ask\")", async () => {
  const exec: DockerExec = async () => ({ code: 1, stderr: "Cannot connect to the Docker daemon" });
  const err = await dockerPs(["--filter", "name=wtdev-"], exec).then(
    () => null,
    (e: Error) => e,
  );
  expect(err!.message).toContain("Cannot connect to the Docker daemon");
});

test("dockerPs: exit code 0 → line-by-line list without empty lines", async () => {
  const calls: string[][] = [];
  const exec: DockerExec = async (argv) => (calls.push(argv), { code: 0, stderr: "", stdout: "wtdev-a\nwtdev-b\n" });
  expect(await dockerPs(["-aq", "--filter", "name=wtdev-"], exec)).toEqual(["wtdev-a", "wtdev-b"]);
  expect(calls).toEqual([["ps", "-aq", "--filter", "name=wtdev-"]]);
});

test("dockerPs: empty output → empty list", async () => {
  const exec: DockerExec = async () => ({ code: 0, stderr: "", stdout: "\n" });
  expect(await dockerPs(["-aq"], exec)).toEqual([]);
});
