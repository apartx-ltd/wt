#!/usr/bin/env bun
import {
  BASE_SLUG,
  resolveOrch,
  resolveBasePort,
  readWorktreePort,
  listWorktrees,
  listRunningInstances,
  listProjects,
  createWorktree,
  removeWorktree,
  stopInstance,
  stopAll,
  reapContainers,
  migrateBaseSlugArtifacts,
  startInstance,
  runForeground,
  resolveCoreStack,
  resolveServerProject,
  resolveProjectsDir,
  resolveLogSource,
  listLogFiles,
  removeLinks,
  applyLinks,
  worktreeDir,
  projectDir,
  collectSweepFacts,
  sweepOne,
  type SweepItem,
  collectSlimFacts,
  slimOne,
  removeVolumes,
  type StopOutcome,
} from "#core";
import { registerBundledPlugins } from "#plugins";
import { existsSync } from "node:fs";
import { col, fmtUptime, stopLine } from "../src/format";
import { resolveProjectArg, parseWebArgs } from "../src/args";
import { runTui, runWeb } from "../src/dashboards";
import pkg from "../../package.json";

// Register the bundled plugins once at process start: start/new resolve the project's
// plugin through the registry (loadPlugin). Idempotent (Map.set).
registerBundledPlugins();

const [cmd, ...rest] = process.argv.slice(2);
// Version comes before the workspace topology: printed from anywhere, with no config and no side effects.
if (cmd === "version" || cmd === "--version") {
  console.log(pkg.version);
  process.exit(0);
}

const json = rest.includes("--json");
const args = rest.filter((a) => a !== "--json");
const die = (msg: string): never => {
  process.stderr.write(`wt: ${msg}\n`);
  process.exit(1);
};

// Workspace — resolved lazily (loadWorkspace) only for commands that need it, so `help`
// works from any directory. In single-repo (projectsDir === ".") the project is implicit
// (the only one in the workspace), and the CLI lets you omit <project> from the arguments.
let orch: string;
let projectsDir: string;
let singleRepo: boolean;
let projCtx: { singleRepo: boolean; soleProject: string | undefined };

async function loadWorkspace() {
  orch = resolveOrch(); // WorkspaceNotFoundError → dispatcher's catch → `wt: <message>`, exit 1
  projectsDir = await resolveProjectsDir(orch);
  singleRepo = projectsDir === ".";
  const soleProject = singleRepo ? (await listProjects(orch))[0] : undefined;
  projCtx = { singleRepo, soleProject };
  await migrateBaseSlugArtifacts(orch); // one-off rename -main.*→-base.* (M2.5)
}

async function cmdPort() {
  const positional = args.filter((a) => !a.startsWith("--"));
  const { project, pos } = resolveProjectArg(positional, projCtx);
  const slug = pos[0] ?? BASE_SLUG;
  if (!project) die(singleRepo ? "usage: wt port [slug]" : "usage: wt port <project> [slug]");
  let port: number | null;
  if (slug === BASE_SLUG) {
    port = await resolveBasePort(projectDir(orch, project!, projectsDir));
  } else {
    port = await readWorktreePort(worktreeDir(orch, project!, slug));
    if (port === null) die(`no .env.worktree for ${project}/${slug}`);
  }
  if (json) console.log(JSON.stringify({ project, slug, port }));
  else console.log(port ?? "");
}

async function cmdProjects() {
  const projects = await listProjects(orch);
  if (json) console.log(JSON.stringify(projects));
  else for (const p of projects) console.log(p);
}

async function cmdList() {
  const wts = await listWorktrees(orch);
  if (json) {
    console.log(JSON.stringify(wts));
    return;
  }
  console.log(col("PROJECT", 16) + " " + col("BRANCH", 22) + " " + col("PORT", 6) + " PATH");
  for (const w of wts) {
    console.log(
      col(w.project, 16) + " " + col(w.branch, 22) + " " + col(String(w.port ?? "-"), 6) + " " + w.path,
    );
  }
}

async function cmdPs() {
  const insts = await listRunningInstances(orch);
  if (json) {
    console.log(JSON.stringify(insts));
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  console.log(
    col("PROJECT", 16) + " " + col("SLUG", 14) + " " + col("BRANCH", 22) + " " +
      col("PORT", 6) + " " + col("PID", 8) + " " + col("UPTIME", 8),
  );
  let any = false;
  for (const i of insts) {
    console.log(
      col(i.project, 16) + " " + col(i.slug, 14) + " " + col(i.branch, 22) + " " +
        col(String(i.port ?? ""), 6) + " " +
        col(i.container ?? String(i.pid ?? ""), 8) + " " + col(fmtUptime(i.started, now), 8),
    );
    any = true;
  }
  if (!any) console.log("(no running instances)");
}

async function cmdNew() {
  const positional = args.filter((a) => !a.startsWith("--"));
  const { project, pos } = resolveProjectArg(positional, projCtx);
  const slug = pos[0];
  if (!project || !slug)
    die(singleRepo ? "usage: wt new <slug> [--isolated-db] [--seed]" : "usage: wt new <project> <slug> [--isolated-db] [--seed]");
  const opts = { isolatedDb: rest.includes("--isolated-db"), seed: rest.includes("--seed") };
  const r = await createWorktree(orch, project!, slug!, opts);
  if (json) console.log(JSON.stringify(r));
  else console.log(`done: ${r.dir} (branch ${r.branch}, PORT=${r.port}) — start it: wt start ${singleRepo ? slug : `${project} ${slug}`}`);
}

/**
 * Report for a batch of stops (`wt stop --all` / `wt down`). Failures are printed one by one
 * to stderr and yield a non-zero exit code — a silent "all instances stopped" on top of a
 * container that was not removed breaks the next `wt start`.
 */
function reportStopAll(res: StopOutcome[]): void {
  const failed = res.filter((r) => r.error);
  for (const r of failed) process.stderr.write(`wt: ${stopLine(r.project, r.slug, r).text}\n`);
  if (!json) {
    const acted = res.filter((r) => !r.error && r.action !== "cleanup").length;
    console.log(acted ? "all instances stopped" : failed.length ? "nothing was stopped" : "nothing to stop");
  }
  if (failed.length) process.exit(1);
}

async function cmdStop() {
  if (args[0] === "--all") {
    const res = await stopAll(orch);
    if (json) console.log(JSON.stringify(res));
    return reportStopAll(res);
  }
  const positional = args.filter((a) => !a.startsWith("--"));
  const { project, pos } = resolveProjectArg(positional, projCtx);
  const slug = pos[0] ?? BASE_SLUG;
  if (!project) die(singleRepo ? "usage: wt stop [slug] | wt stop --all" : "usage: wt stop <project> [slug] | wt stop --all");
  const r = await stopInstance(orch, project!, slug);
  if (r === null) die(`${project}/${slug} is not running`);
  if (json) console.log(JSON.stringify(r));
  const line = stopLine(project!, slug, r!);
  if (!line.ok) die(line.text);
  if (!json) console.log(line.text);
}

async function cmdLogs() {
  const follow = rest.includes("-f");
  if (args[0] === "--all") {
    const files = await listLogFiles(orch);
    if (!files.length) die("no logs");
    const proc = Bun.spawn(["tail", "-n", "20", "-f", ...files], { stdout: "inherit", stderr: "inherit" });
    process.exit(await proc.exited);
  }
  const positional = args.filter((a) => !a.startsWith("--") && a !== "-f");
  const { project, pos } = resolveProjectArg(positional, projCtx);
  const slug = pos[0] ?? BASE_SLUG;
  if (!project) die(singleRepo ? "usage: wt logs [slug] [-f] | wt logs --all" : "usage: wt logs <project> [slug] [-f] | wt logs --all");
  const src = await resolveLogSource(orch, project!, slug);
  if (!src) die(`no log for ${project}/${slug} (was it started with wt start?)`);
  const cmd =
    src!.kind === "docker"
      ? ["docker", "logs", "--tail", "50", ...(follow ? ["-f"] : []), src!.container]
      : ["tail", "-n", "50", ...(follow ? ["-f"] : []), src!.path];
  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  process.exit(await proc.exited);
}

async function cmdRm() {
  const positional = args.filter((a) => !a.startsWith("--"));
  const { project, pos } = resolveProjectArg(positional, projCtx);
  const slug = pos[0];
  if (!project || !slug) die(singleRepo ? "usage: wt rm <slug> [--branch]" : "usage: wt rm <project> <slug> [--branch]");
  await removeWorktree(orch, project!, slug!, { dropBranch: rest.includes("--branch") });
  if (json) console.log(JSON.stringify({ project, slug, removed: true }));
  else console.log(`removed worktree ${project}/${slug} (the branch's port stays reserved in the registry)`);
}

async function cmdUnlink() {
  const positional = args.filter((a) => !a.startsWith("--"));
  const { project, pos } = resolveProjectArg(positional, projCtx);
  const slug = pos[0];
  if (!project || !slug) die(singleRepo ? "usage: wt unlink <slug>" : "usage: wt unlink <project> <slug>");
  await removeLinks(orch, project!, slug!);
  if (json) console.log(JSON.stringify({ project, slug, unlinked: true }));
  else console.log(`unlink ${project}/${slug} — back to settings.json/.env from the repo (restart: wt restart ${singleRepo ? slug : `${project} ${slug}`})`);
}

async function cmdLink() {
  const positional = args.filter((a) => !a.startsWith("--"));
  const { project, pos } = resolveProjectArg(positional, projCtx);
  const slug = pos[0];
  const lslug = pos[1];
  if (!project || !slug) die(singleRepo ? "usage: wt link <slug> [link-slug]" : "usage: wt link <project> <slug> [link-slug]");
  const dir = slug === BASE_SLUG ? projectDir(orch, project!, projectsDir) : worktreeDir(orch, project!, slug!);
  if (!existsSync(dir)) die(`no worktree: ${project}/${slug} (create it: wt new ${singleRepo ? slug : `${project} ${slug}`})`);
  const outcomes = await applyLinks(orch, project!, slug!, lslug ?? slug!);
  if (json) return void console.log(JSON.stringify(outcomes));
  const matched = outcomes.filter((o) => o.status !== "skip-no-port");
  if (matched.length === 0) {
    console.log(`link: ${project} has no configured/running upstreams in LINKS`);
    return;
  }
  for (const o of outcomes) {
    if (o.status === "written") console.log(`link: ${project}/${slug}  ${o.key} → ${o.value}  (${o.target})`);
    else if (o.status === "skip-no-port") console.log(`link: skipping ${project} → ${o.target} (no worktree ${o.target}/${lslug ?? slug})`);
    else console.log(`link: ${project} — no source for ${o.key}, skipping`);
  }
  console.log(`to apply: wt restart ${singleRepo ? slug : `${project} ${slug}`}`);
}

async function parseStartOpts(pos: string[]): Promise<{ link?: "all" | string; linkSlug?: string }> {
  // pos — positionals after resolveProjectArg: pos[0]=slug, pos[1]=link-slug.
  // Multi-repo: pos = positional.slice(1), so pos[1] === the old positional[2] (parity).
  const o: { link?: "all" | string; linkSlug?: string } = {};
  if (rest.includes("--server")) {
    const srv = await resolveServerProject(orch);
    if (!srv) die("--server: serverProject is not set in wt.config (name the upstream project)");
    o.link = srv!;
  } else if (rest.includes("--link")) {
    o.link = "all";
  }
  if (pos[1]) o.linkSlug = pos[1];
  return o;
}

function reportStart(r: { project: string; slug: string; port: number; pid: number | null; container: string | null; portUp: boolean }) {
  const who = r.container ?? `PID ${r.pid}`;
  if (r.portUp) console.log(`started ${r.project}/${r.slug} — ${who}, up on :${r.port} (wt logs ${r.project} ${r.slug} -f)`);
  else console.log(`started ${r.project}/${r.slug} — ${who}, did NOT come up in time — see wt logs ${r.project} ${r.slug}`);
}

async function cmdStart() {
  const positional = args.filter((a) => !a.startsWith("--"));
  const { project, pos } = resolveProjectArg(positional, projCtx);
  const slug = pos[0] ?? BASE_SLUG;
  if (!project) die(singleRepo ? "usage: wt start [slug] [--link|--server [link-slug]]" : "usage: wt start <project> [slug] [--link|--server [link-slug]]");
  const r = await startInstance(orch, project!, slug, await parseStartOpts(pos));
  if (json) return void console.log(JSON.stringify(r));
  reportStart(r);
}

async function cmdRun() {
  const positional = args.filter((a) => !a.startsWith("--"));
  const { project, pos } = resolveProjectArg(positional, projCtx);
  const slug = pos[0] ?? BASE_SLUG;
  if (!project) die(singleRepo ? "usage: wt run [slug] [--link|--server [link-slug]]" : "usage: wt run <project> [slug] [--link|--server [link-slug]]");
  process.exit(await runForeground(orch, project!, slug, await parseStartOpts(pos)));
}

async function cmdRestart() {
  const positional = args.filter((a) => !a.startsWith("--"));
  const { project, pos } = resolveProjectArg(positional, projCtx);
  const slug = pos[0] ?? BASE_SLUG;
  if (!project) die(singleRepo ? "usage: wt restart [slug]" : "usage: wt restart <project> [slug]");
  const stopped = await stopInstance(orch, project!, slug).catch(() => null);
  // do not abort: start removes a stuck container itself and shows the reason if it cannot
  if (stopped?.error) process.stderr.write(`wt: ${stopLine(project!, slug, stopped).text}\n`);
  await Bun.sleep(1000);
  const r = await startInstance(orch, project!, slug, await parseStartOpts(pos));
  if (json) return void console.log(JSON.stringify(r));
  reportStart(r);
}

async function cmdUp() {
  const results = [];
  for (const [p, s] of await resolveCoreStack(orch)) {
    try {
      results.push(await startInstance(orch, p, s));
    } catch (e) {
      console.error(`wt: up ${p}/${s}: ${(e as Error).message}`);
    }
  }
  if (json) return void console.log(JSON.stringify(results));
  for (const r of results) reportStart(r);
}

async function cmdDown() {
  const res = await stopAll(orch);
  if (json) console.log(JSON.stringify(res));
  return reportStopAll(res);
}

function fmtGb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1) + "G";
}

async function cmdSweep() {
  const apply = rest.includes("--apply");
  const items = await collectSweepFacts(orch);
  if (json) return void console.log(JSON.stringify(items));

  const toSweep = items.filter((i) => i.action === "sweep");
  const skipped = items.filter((i) => i.action !== "sweep");
  const line = (i: SweepItem) =>
    col(i.project, 16) + " " + col(i.slug, 26) + " " + col(i.branch, 34) + " " +
    col(fmtGb(i.diskBytes), 6) + " " + (i.mr ? `!${i.mr}` : "") + (i.running ? " [running]" : "");

  console.log(`— will remove (${toSweep.length}):`);
  for (const i of toSweep) console.log("  " + line(i));
  console.log(`— skipping (${skipped.length}):`);
  for (const i of skipped) console.log("  " + line(i) + "  [" + i.reason + "]");
  const gb = toSweep.reduce((s, i) => s + i.diskBytes, 0);
  console.log(`total: ${toSweep.length} worktree(s), ~${fmtGb(gb)} to free`);

  if (!apply) {
    if (toSweep.length) console.log("dry-run — to execute: wt sweep --apply");
    return;
  }
  for (const i of toSweep) {
    await sweepOne(orch, i);
    console.log(`removed ${i.project}/${i.slug} (branch ${i.branch}, MR !${i.mr})`);
  }
  console.log(`done: removed ${toSweep.length}, freed ~${fmtGb(gb)}`);
}

async function cmdSlim() {
  const apply = rest.includes("--apply");
  const plan = await collectSlimFacts(orch);
  if (json) return void console.log(JSON.stringify(plan));
  const { items, orphanVolumes } = plan;

  const toSlim = items.filter((i) => i.action === "slim").sort((a, b) => b.hostBytes - a.hostBytes);
  const running = items.filter((i) => i.reason === "running");
  console.log(`— will clean (${toSlim.length}):`);
  for (const i of toSlim)
    console.log("  " + col(i.project, 20) + " " + col(i.slug, 30) + " " + col(fmtGb(i.hostBytes), 6) +
      (i.volumes.length ? ` + volumes: ${i.volumes.length}` : ""));
  if (running.length)
    console.log(`— running, leaving alone (${running.length}): ` + running.map((i) => `${i.project}/${i.slug}`).join(", "));
  if (orphanVolumes.length) {
    console.log(`— orphan volumes, the worktree is gone (${orphanVolumes.length}):`);
    for (const v of orphanVolumes) console.log("  " + v);
  }
  const gb = toSlim.reduce((s, i) => s + i.hostBytes, 0);
  const vols = toSlim.reduce((s, i) => s + i.volumes.length, 0) + orphanVolumes.length;
  console.log(`total: ${toSlim.length} worktree(s), ~${fmtGb(gb)} on the host + ${vols} docker volume(s) (size not measured)`);

  if (!apply) {
    if (toSlim.length || orphanVolumes.length) console.log("dry-run — to execute: wt slim --apply");
    return;
  }
  const keptOrphans = await removeVolumes(orphanVolumes);
  console.log(`orphan volumes removed: ${orphanVolumes.length - keptOrphans.length}` +
    (keptOrphans.length ? ` (in use, kept: ${keptOrphans.join(", ")})` : ""));
  for (const i of toSlim) {
    const r = await slimOne(orch, i);
    if (r.started) {
      console.log(`skipped ${i.project}/${i.slug}: it was started in the meantime`);
      continue;
    }
    const kept = r.keptVolumes.length ? ` (volumes in use, kept: ${r.keptVolumes.join(", ")})` : "";
    console.log(`cleaned ${i.project}/${i.slug}${kept}`);
  }
  console.log(`done: ~${fmtGb(gb)} on the host; wt start will restore the dependencies`);
}

async function cmdReap() {
  const { removed } = await reapContainers(orch);
  if (json) return void console.log(JSON.stringify({ removed }));
  console.log(removed ? `reap: removed all wtdev-* dev containers (${removed})` : "reap: no dev containers found");
}

const USAGE = `wt — multi-branch development in the ApartX orchestrator.

(single-repo workspace: omit <project> — it is implied, e.g. \`wt new <slug>\`)

Commands (slug is optional: without it = the base checkout projects/<p>, slug "base"):
  new   <p> <slug> [--isolated-db [--seed]]   create worktree+branch+install+env
  run   <p> [slug] [--link|--server [slug]]   run in the foreground (Ctrl-C, host projects only)
  start <p> [slug] [--link|--server [slug]]   run in the background (host: pidfile+log / dockerized: container)
  stop  <p> [slug] | --all                    stop an instance / all of them
  restart <p> [slug]                          stop + start
  up                                          bring up the core set (server+cabinet+admin)
  down                                        stop everything
  ps    [--json]                              running instances
  list  [--json]                              existing worktrees
  logs  <p> [slug] [-f] | --all               logs of background instance(s)
  link  <p> <slug> [slug]                     link to all worktree upstreams (the LINKS mesh)
  unlink <p> <slug>                           restore settings.json/.env from the repository
  rm    <p> <slug> [--branch]                 remove a worktree (+ optionally its branch)
  reap                                        remove all wtdev-* dev containers
  sweep [--apply] [--json]                    remove worktrees whose branches are merged in GitLab (without --apply = plan)
  slim  [--apply] [--json]                    remove node_modules/.meteor/local/docker volumes in all stopped worktrees + orphan volumes (without --apply = plan)
  port  <p> [slug] [--json]                   print the allocated port
  projects [--json]                           list projects
  ui                                          full-screen TUI dashboard
  web [--dev]                                 web dashboard (built static; --dev runs vite dev)
  version | --version                         wt version
`;

async function cmdUi() {
  process.exit(await runTui(args, { orch }));
}

async function cmdWeb() {
  process.exit(await runWeb({ ...parseWebArgs(args), orch }));
}

async function cmdHelp() {
  process.stdout.write(USAGE);
}

const table: Record<string, () => Promise<void>> = {
  port: cmdPort,
  projects: cmdProjects,
  list: cmdList,
  ps: cmdPs,
  new: cmdNew,
  start: cmdStart,
  run: cmdRun,
  restart: cmdRestart,
  up: cmdUp,
  stop: cmdStop,
  down: cmdDown,
  reap: cmdReap,
  sweep: cmdSweep,
  slim: cmdSlim,
  logs: cmdLogs,
  rm: cmdRm,
  link: cmdLink,
  unlink: cmdUnlink,
  ui: cmdUi,
  web: cmdWeb,
  help: cmdHelp,
  "--help": cmdHelp,
  "-h": cmdHelp,
};
const handler = cmd ? table[cmd] : cmdHelp; // no command → help
if (handler) {
  // Without this any throw from the core reached the user as a Bun stack trace, and the message
  // (docker's failure reason) got buried. WT_DEBUG=1 brings the stack back.
  try {
    if (handler !== cmdHelp) await loadWorkspace();
    await handler();
  } catch (e) {
    if (process.env.WT_DEBUG) console.error(e);
    die(e instanceof Error ? e.message : String(e));
  }
} else {
  process.stderr.write(`wt: unknown command: ${cmd}\n`);
  process.stdout.write(USAGE);
  process.exit(1);
}
