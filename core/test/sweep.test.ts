import { test, expect } from "bun:test";
import { classifySweep, parseGitlabProjectPath, type WorktreeFacts } from "../src/sweep";

const base: WorktreeFacts = {
  project: "apartx-cabinet",
  slug: "ai-title",
  branch: "feature/ai-title",
  path: "/orch/worktrees/apartx-cabinet/ai-title",
  detached: false,
  dirty: false,
  upstream: "gone",
  aheadOfUpstream: 0,
  headMatchesMergedMr: true,
  mrs: [{ iid: 42, state: "merged", sha: "abc" }],
  diskBytes: 1024,
  running: false,
};

test("merged + clean + head matches MR → sweep", () => {
  expect(classifySweep(base)).toEqual({ action: "sweep", reason: "merged", mr: 42 });
});

test("detached HEAD → manual", () => {
  expect(classifySweep({ ...base, detached: true, branch: "" }))
    .toEqual({ action: "manual", reason: "detached" });
});

test("dirty tree → skip даже при merged MR", () => {
  expect(classifySweep({ ...base, dirty: true }))
    .toEqual({ action: "skip", reason: "dirty" });
});

test("открытый MR → skip open-mr", () => {
  expect(classifySweep({ ...base, mrs: [{ iid: 7, state: "opened", sha: "abc" }] }))
    .toEqual({ action: "skip", reason: "open-mr", mr: 7 });
});

test("merged И открытый MR (переоткрыли) → skip open-mr", () => {
  expect(classifySweep({
    ...base,
    mrs: [{ iid: 42, state: "merged", sha: "abc" }, { iid: 50, state: "opened", sha: "def" }],
  })).toEqual({ action: "skip", reason: "open-mr", mr: 50 });
});

test("нет MR вообще → skip no-mr", () => {
  expect(classifySweep({ ...base, mrs: [] })).toEqual({ action: "skip", reason: "no-mr" });
});

test("только закрытый без мержа MR → skip closed-mr", () => {
  expect(classifySweep({ ...base, mrs: [{ iid: 9, state: "closed", sha: "abc" }] }))
    .toEqual({ action: "skip", reason: "closed-mr", mr: 9 });
});

test("upstream жив, есть unpushed-коммиты → skip unpushed", () => {
  expect(classifySweep({ ...base, upstream: "live", aheadOfUpstream: 2 }))
    .toEqual({ action: "skip", reason: "unpushed" });
});

test("upstream жив, unpushed нет → sweep", () => {
  expect(classifySweep({ ...base, upstream: "live", aheadOfUpstream: 0 }))
    .toEqual({ action: "sweep", reason: "merged", mr: 42 });
});

test("remote-ветка удалена, HEAD не совпадает с sha мержа → skip commits-after-merge", () => {
  expect(classifySweep({ ...base, headMatchesMergedMr: false }))
    .toEqual({ action: "skip", reason: "commits-after-merge" });
});

test("ветка ни разу не пушилась (upstream none, MR нет) → skip no-mr", () => {
  expect(classifySweep({ ...base, upstream: "none", mrs: [] }))
    .toEqual({ action: "skip", reason: "no-mr" });
});

test("parseGitlabProjectPath: ssh и https формы", () => {
  expect(parseGitlabProjectPath("git@gitlab.com:apartx/apartx-cabinet.git"))
    .toBe("apartx/apartx-cabinet");
  expect(parseGitlabProjectPath("https://gitlab.com/apartx/apartx-server.git"))
    .toBe("apartx/apartx-server");
  expect(parseGitlabProjectPath("https://gitlab.com/apartx/apartx-server"))
    .toBe("apartx/apartx-server");
  expect(parseGitlabProjectPath("https://github.com/foo/bar.git")).toBeNull();
});
