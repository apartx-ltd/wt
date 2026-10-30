// wt sweep — поиск и снос worktree, чьи ветки уже смержены в GitLab.
// Истина о «смержено» — состояние MR (squash-мержи делают git-ancestry бесполезной).
// classifySweep — чистая функция над собранными фактами; сеть/git только в сборщике.

import type { Worktree } from "#shared";
import { listWorktrees } from "./worktrees";
import { listRunningInstances } from "./run";
import { removeWorktree } from "./new-worktree";
import { projectDir } from "./paths";
import { resolveProjectsDir } from "./config";

export interface MrInfo {
  iid: number;
  state: "opened" | "closed" | "locked" | "merged";
  /** SHA последнего коммита source-ветки (на момент мержа для merged). */
  sha: string;
}

export interface WorktreeFacts {
  project: string;
  slug: string;
  branch: string; // "" для detached
  path: string;
  detached: boolean;
  dirty: boolean;
  /** live = origin/<branch> существует; gone = был upstream, ветку удалили; none = не пушилась. */
  upstream: "live" | "gone" | "none";
  aheadOfUpstream: number; // считается только при upstream === "live"
  /** HEAD == sha смерженного MR или его предок (защита от коммитов после мержа). */
  headMatchesMergedMr: boolean;
  mrs: MrInfo[];
  diskBytes: number;
  running: boolean;
}

export type SweepReason =
  | "merged" | "detached" | "dirty" | "open-mr" | "no-mr"
  | "closed-mr" | "unpushed" | "commits-after-merge";

export interface SweepDecision {
  action: "sweep" | "skip" | "manual";
  reason: SweepReason;
  mr?: number;
}

export function classifySweep(f: WorktreeFacts): SweepDecision {
  if (f.detached) return { action: "manual", reason: "detached" };
  if (f.dirty) return { action: "skip", reason: "dirty" };
  const open = f.mrs.find((m) => m.state === "opened" || m.state === "locked");
  if (open) return { action: "skip", reason: "open-mr", mr: open.iid };
  const merged = f.mrs.find((m) => m.state === "merged");
  if (!merged) {
    const closed = f.mrs.find((m) => m.state === "closed");
    if (closed) return { action: "skip", reason: "closed-mr", mr: closed.iid };
    return { action: "skip", reason: "no-mr" };
  }
  if (f.upstream === "live" && f.aheadOfUpstream > 0) return { action: "skip", reason: "unpushed" };
  if (f.upstream !== "live" && !f.headMatchesMergedMr)
    return { action: "skip", reason: "commits-after-merge" };
  return { action: "sweep", reason: "merged", mr: merged.iid };
}

/** "git@gitlab.com:g/p.git" | "https://gitlab.com/g/p(.git)" → "g/p"; не-GitLab → null. */
export function parseGitlabProjectPath(remoteUrl: string): string | null {
  const m = remoteUrl.trim().match(/^(?:git@gitlab\.com:|https:\/\/gitlab\.com\/)(.+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}

interface ShOut { ok: boolean; stdout: string; stderr: string }
async function shOut(cmd: string[], cwd?: string): Promise<ShOut> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { ok: (await proc.exited) === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

/** glab с ретраями: rate-limit/сетевые сбои GitLab транзиентны, один отказ не должен ронять прогон. */
async function fetchMrs(glProject: string, branch: string): Promise<MrInfo[]> {
  const enc = encodeURIComponent(glProject);
  const url = `projects/${enc}/merge_requests?source_branch=${encodeURIComponent(branch)}&state=all&per_page=100`;
  let lastErr = "";
  for (const delayMs of [0, 2000, 5000, 15000]) {
    if (delayMs) await Bun.sleep(delayMs);
    const r = await shOut(["glab", "api", url]);
    if (r.ok) {
      return (JSON.parse(r.stdout) as Array<{ iid: number; state: MrInfo["state"]; sha: string }>)
        .map((m) => ({ iid: m.iid, state: m.state, sha: m.sha }));
    }
    lastErr = r.stderr || r.stdout;
  }
  throw new Error(`glab api merge_requests(${glProject}, ${branch}): ${lastErr || "failed"} — glab auth status?`);
}

/** fetch --prune + починка origin/HEAD; один раз на проект. */
async function prepProject(pdir: string): Promise<void> {
  await shOut(["git", "-C", pdir, "fetch", "--prune", "origin"]);
  await shOut(["git", "-C", pdir, "remote", "set-head", "origin", "-a"]);
}

async function collectFacts(w: Worktree, glProject: string | null, running: Set<string>): Promise<WorktreeFacts> {
  const g = (args: string[]) => shOut(["git", "-C", w.path, ...args]);
  const detached = w.branch === "";
  const dirty = (await g(["status", "--porcelain"])).stdout !== "";
  let upstream: WorktreeFacts["upstream"] = "none";
  let ahead = 0;
  if (!detached) {
    const hasCfg = (await g(["config", `branch.${w.branch}.remote`])).ok;
    const remoteRef = (await g(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${w.branch}`])).ok;
    upstream = remoteRef ? "live" : hasCfg ? "gone" : "none";
    if (upstream === "live") {
      const r = await g(["rev-list", "--count", `origin/${w.branch}..HEAD`]);
      ahead = r.ok ? parseInt(r.stdout, 10) || 0 : 0;
    }
  }
  const mrs = detached || !glProject ? [] : await fetchMrs(glProject, w.branch);
  const merged = mrs.find((m) => m.state === "merged");
  let headMatches = false;
  if (merged) {
    const head = (await g(["rev-parse", "HEAD"])).stdout;
    headMatches = head === merged.sha || (await g(["merge-base", "--is-ancestor", "HEAD", merged.sha])).ok;
  }
  const du = await shOut(["du", "-sk", w.path]);
  const diskBytes = du.ok ? (parseInt(du.stdout.split("\t")[0], 10) || 0) * 1024 : 0;
  return {
    project: w.project, slug: w.slug, branch: w.branch, path: w.path,
    detached, dirty, upstream, aheadOfUpstream: ahead,
    headMatchesMergedMr: headMatches, mrs, diskBytes,
    running: running.has(`${w.project}/${w.slug}`),
  };
}

export interface SweepItem extends SweepDecision {
  project: string; slug: string; branch: string; diskBytes: number; running: boolean;
}

export async function collectSweepFacts(orch: string): Promise<SweepItem[]> {
  const projectsDir = await resolveProjectsDir(orch);
  const wts = await listWorktrees(orch);
  const running = new Set((await listRunningInstances(orch)).map((i) => `${i.project}/${i.slug}`));
  const glPaths = new Map<string, string | null>();
  for (const p of new Set(wts.map((w) => w.project))) {
    const pdir = projectDir(orch, p, projectsDir);
    await prepProject(pdir);
    const url = await shOut(["git", "-C", pdir, "remote", "get-url", "origin"]);
    glPaths.set(p, url.ok ? parseGitlabProjectPath(url.stdout) : null);
  }
  const out: SweepItem[] = [];
  for (const w of wts) {
    const facts = await collectFacts(w, glPaths.get(w.project) ?? null, running);
    out.push({ ...classifySweep(facts), project: w.project, slug: w.slug, branch: w.branch,
      diskBytes: facts.diskBytes, running: facts.running });
  }
  return out;
}

/** Снос одного кандидата: removeWorktree (сам стопит инстанс) + форс-удаление ветки.
 * НЕ dropBranch: тот выводит ветку как prefix+slug (slug ≠ ветка у части worktree)
 * и использует `branch -d`, отказывающий squash-смерженным. Мерж подтверждён GitLab API. */
export async function sweepOne(orch: string, item: SweepItem): Promise<void> {
  await removeWorktree(orch, item.project, item.slug, {});
  const pdir = projectDir(orch, item.project, await resolveProjectsDir(orch));
  await shOut(["git", "-C", pdir, "branch", "-D", item.branch]);
}
