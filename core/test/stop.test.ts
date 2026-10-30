import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { stopInstance, stopAll, type AliveProbes, type StopActions } from "../src/run";

function orchWith(runfiles: Record<string, string>): string {
  const orch = mkdtempSync(resolve(tmpdir(), "wt-stop-"));
  mkdirSync(resolve(orch, "var", "run"), { recursive: true });
  for (const [name, body] of Object.entries(runfiles)) {
    writeFileSync(resolve(orch, "var", "run", name), body);
  }
  return orch;
}

const aliveProbes: AliveProbes = { dockerRunning: async () => true, pidAlive: () => true };
const deadProbes: AliveProbes = { dockerRunning: async () => false, pidAlive: () => false };

function recorder() {
  const calls: string[] = [];
  const actions: StopActions = {
    dockerRm: async (c) => void calls.push(`rm ${c}`),
    killTree: async (pid, pg) => void calls.push(`kill ${pid} pg=${pg}`),
  };
  return { calls, actions };
}

test("stopInstance: container → dockerRm + runfile removed", async () => {
  const orch = orchWith({
    "apartx-server-feat.run": "container=wtdev-apartx-server-feat\nport=4010\nbranch=b\nstarted=1\nproject=apartx-server\nslug=feat\n",
  });
  try {
    const { calls, actions } = recorder();
    const r = await stopInstance(orch, "apartx-server", "feat", deadProbes, actions); // container: rm regardless of alive
    expect(r).toMatchObject({ action: "container", container: "wtdev-apartx-server-feat" });
    expect(calls).toEqual(["rm wtdev-apartx-server-feat"]);
    expect(existsSync(resolve(orch, "var", "run", "apartx-server-feat.run"))).toBe(false);
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("stopInstance: live host pid → killTree(pgroup) + runfile removed", async () => {
  const orch = orchWith({
    "apartx-help-x.run": "pid=4242\nport=3701\nbranch=b\nstarted=1\nproject=apartx-help\nslug=x\npgroup=1\n",
  });
  try {
    const { calls, actions } = recorder();
    const r = await stopInstance(orch, "apartx-help", "x", aliveProbes, actions);
    expect(r).toMatchObject({ action: "pid", pid: 4242 });
    expect(calls).toEqual(["kill 4242 pg=true"]);
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("stopInstance: dead host pid → cleanup only (no kill), runfile removed", async () => {
  const orch = orchWith({
    "apartx-help-x.run": "pid=4242\nport=3701\nbranch=b\nstarted=1\nproject=apartx-help\nslug=x\n",
  });
  try {
    const { calls, actions } = recorder();
    const r = await stopInstance(orch, "apartx-help", "x", deadProbes, actions);
    expect(r?.action).toBe("cleanup");
    expect(calls).toEqual([]);
    expect(existsSync(resolve(orch, "var", "run", "apartx-help-x.run"))).toBe(false);
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("stopInstance: missing runfile → null", async () => {
  const orch = orchWith({});
  try {
    expect(await stopInstance(orch, "nope", "nope")).toBeNull();
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("stopInstance: dockerRm упал → error в исходе, runfile СОХРАНЁН", async () => {
  const orch = orchWith({
    "apartx-cabinet-gateway-qr.run":
      "container=wtdev-apartx-cabinet-gateway-qr\nport=3520\nbranch=b\nstarted=1\nproject=apartx-cabinet\nslug=gateway-qr\n",
  });
  try {
    const actions: StopActions = {
      dockerRm: async () => {
        throw new Error("docker rm -f wtdev-apartx-cabinet-gateway-qr → код 1: Cannot connect to the Docker daemon");
      },
      killTree: async () => {},
    };
    const r = await stopInstance(orch, "apartx-cabinet", "gateway-qr", deadProbes, actions);
    expect(r?.action).toBe("container");
    expect(r?.error).toContain("Cannot connect to the Docker daemon");
    // инстанс не снят — runfile должен пережить неудачу, иначе он пропадёт из ps/reap
    expect(existsSync(resolve(orch, "var", "run", "apartx-cabinet-gateway-qr.run"))).toBe(true);
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("stopInstance: killTree упал → error в исходе, runfile СОХРАНЁН", async () => {
  const orch = orchWith({
    "apartx-help-x.run": "pid=4242\nport=3701\nbranch=b\nstarted=1\nproject=apartx-help\nslug=x\npgroup=1\n",
  });
  try {
    const actions: StopActions = {
      dockerRm: async () => {},
      killTree: async () => {
        throw new Error("EPERM");
      },
    };
    const r = await stopInstance(orch, "apartx-help", "x", aliveProbes, actions);
    expect(r?.error).toContain("EPERM");
    expect(existsSync(resolve(orch, "var", "run", "apartx-help-x.run"))).toBe(true);
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("stopInstance: успех → error=null", async () => {
  const orch = orchWith({
    "apartx-server-feat.run": "container=wtdev-apartx-server-feat\nport=4010\nbranch=b\nstarted=1\nproject=apartx-server\nslug=feat\n",
  });
  try {
    const { actions } = recorder();
    expect((await stopInstance(orch, "apartx-server", "feat", deadProbes, actions))?.error).toBeNull();
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("stopAll: падение одного инстанса не мешает остальным", async () => {
  const orch = orchWith({
    "apartx-server-a.run": "container=wtdev-apartx-server-a\nport=4010\nbranch=b\nstarted=1\nproject=apartx-server\nslug=a\n",
    "apartx-help-b.run": "pid=999\nport=3701\nbranch=b\nstarted=1\nproject=apartx-help\nslug=b\npgroup=1\n",
  });
  try {
    const actions: StopActions = {
      dockerRm: async (c) => {
        throw new Error(`no such daemon (${c})`);
      },
      killTree: async () => {},
    };
    const res = await stopAll(orch, aliveProbes, actions);
    expect(res).toHaveLength(2);
    expect(res.find((r) => r.slug === "a")?.error).toContain("no such daemon");
    expect(res.find((r) => r.slug === "b")?.error).toBeNull();
    expect(existsSync(resolve(orch, "var", "run", "apartx-server-a.run"))).toBe(true);
    expect(existsSync(resolve(orch, "var", "run", "apartx-help-b.run"))).toBe(false);
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});

test("stopAll: acts on each runfile and removes all", async () => {
  const orch = orchWith({
    "apartx-server-a.run": "container=wtdev-apartx-server-a\nport=4010\nbranch=b\nstarted=1\nproject=apartx-server\nslug=a\n",
    "apartx-help-b.run": "pid=999\nport=3701\nbranch=b\nstarted=1\nproject=apartx-help\nslug=b\npgroup=1\n",
  });
  try {
    const { calls, actions } = recorder();
    const res = await stopAll(orch, aliveProbes, actions);
    expect(res).toHaveLength(2);
    expect(calls.sort()).toEqual(["kill 999 pg=true", "rm wtdev-apartx-server-a"]);
    expect(existsSync(resolve(orch, "var", "run", "apartx-server-a.run"))).toBe(false);
    expect(existsSync(resolve(orch, "var", "run", "apartx-help-b.run"))).toBe(false);
  } finally {
    rmSync(orch, { recursive: true, force: true });
  }
});
