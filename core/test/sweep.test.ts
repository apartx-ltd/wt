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

test("dirty tree → skip even with a merged MR", () => {
  expect(classifySweep({ ...base, dirty: true }))
    .toEqual({ action: "skip", reason: "dirty" });
});

test("open MR → skip open-mr", () => {
  expect(classifySweep({ ...base, mrs: [{ iid: 7, state: "opened", sha: "abc" }] }))
    .toEqual({ action: "skip", reason: "open-mr", mr: 7 });
});

test("merged AND open MR (reopened) → skip open-mr", () => {
  expect(classifySweep({
    ...base,
    mrs: [{ iid: 42, state: "merged", sha: "abc" }, { iid: 50, state: "opened", sha: "def" }],
  })).toEqual({ action: "skip", reason: "open-mr", mr: 50 });
});

test("no MR at all → skip no-mr", () => {
  expect(classifySweep({ ...base, mrs: [] })).toEqual({ action: "skip", reason: "no-mr" });
});

test("only an MR closed without merging → skip closed-mr", () => {
  expect(classifySweep({ ...base, mrs: [{ iid: 9, state: "closed", sha: "abc" }] }))
    .toEqual({ action: "skip", reason: "closed-mr", mr: 9 });
});

test("upstream live, unpushed commits present → skip unpushed", () => {
  expect(classifySweep({ ...base, upstream: "live", aheadOfUpstream: 2 }))
    .toEqual({ action: "skip", reason: "unpushed" });
});

test("upstream live, nothing unpushed → sweep", () => {
  expect(classifySweep({ ...base, upstream: "live", aheadOfUpstream: 0 }))
    .toEqual({ action: "sweep", reason: "merged", mr: 42 });
});

test("remote branch deleted, HEAD does not match the merge sha → skip commits-after-merge", () => {
  expect(classifySweep({ ...base, headMatchesMergedMr: false }))
    .toEqual({ action: "skip", reason: "commits-after-merge" });
});

test("branch never pushed (upstream none, no MR) → skip no-mr", () => {
  expect(classifySweep({ ...base, upstream: "none", mrs: [] }))
    .toEqual({ action: "skip", reason: "no-mr" });
});

test("parseGitlabProjectPath: ssh and https forms", () => {
  expect(parseGitlabProjectPath("git@gitlab.com:apartx/apartx-cabinet.git"))
    .toBe("apartx/apartx-cabinet");
  expect(parseGitlabProjectPath("https://gitlab.com/apartx/apartx-server.git"))
    .toBe("apartx/apartx-server");
  expect(parseGitlabProjectPath("https://gitlab.com/apartx/apartx-server"))
    .toBe("apartx/apartx-server");
  expect(parseGitlabProjectPath("https://github.com/foo/bar.git")).toBeNull();
});
