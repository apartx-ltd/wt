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
import { resolveProjectArg } from "../src/args";
import pkg from "../../package.json";

// Регистрируем бандл-плагины один раз при старте процесса: start/new резолвят плагин
// проекта через реестр (loadPlugin). Идемпотентно (Map.set).
registerBundledPlugins();

const [cmd, ...rest] = process.argv.slice(2);
// Версия — до топологии workspace: печатается где угодно, без конфига и побочных эффектов.
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
// works from any directory. В single-repo (projectsDir === ".") проект неявный
// (единственный в workspace), и CLI разрешает опускать <project> в аргументах.
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
  await migrateBaseSlugArtifacts(orch); // одноразовый ренейм -main.*→-base.* (M2.5)
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
    if (port === null) die(`нет .env.worktree для ${project}/${slug}`);
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
  if (!any) console.log("(нет запущенных инстансов)");
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
  else console.log(`готово: ${r.dir} (branch ${r.branch}, PORT=${r.port}) — запусти: wt start ${singleRepo ? slug : `${project} ${slug}`}`);
}

/**
 * Отчёт по пачке остановок (`wt stop --all` / `wt down`). Неудачи печатаются пофамильно
 * в stderr и дают ненулевой код возврата — молчаливое «остановлены все инстансы» поверх
 * неснятого контейнера ломает следующий `wt start`.
 */
function reportStopAll(res: StopOutcome[]): void {
  const failed = res.filter((r) => r.error);
  for (const r of failed) process.stderr.write(`wt: ${stopLine(r.project, r.slug, r).text}\n`);
  if (!json) {
    const acted = res.filter((r) => !r.error && r.action !== "cleanup").length;
    console.log(acted ? "остановлены все инстансы" : failed.length ? "не остановлено ничего" : "нечего останавливать");
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
  if (r === null) die(`${project}/${slug} не запущен`);
  if (json) console.log(JSON.stringify(r));
  const line = stopLine(project!, slug, r!);
  if (!line.ok) die(line.text);
  if (!json) console.log(line.text);
}

async function cmdLogs() {
  const follow = rest.includes("-f");
  if (args[0] === "--all") {
    const files = await listLogFiles(orch);
    if (!files.length) die("нет логов");
    const proc = Bun.spawn(["tail", "-n", "20", "-f", ...files], { stdout: "inherit", stderr: "inherit" });
    process.exit(await proc.exited);
  }
  const positional = args.filter((a) => !a.startsWith("--") && a !== "-f");
  const { project, pos } = resolveProjectArg(positional, projCtx);
  const slug = pos[0] ?? BASE_SLUG;
  if (!project) die(singleRepo ? "usage: wt logs [slug] [-f] | wt logs --all" : "usage: wt logs <project> [slug] [-f] | wt logs --all");
  const src = await resolveLogSource(orch, project!, slug);
  if (!src) die(`нет лога для ${project}/${slug} (запущен ли через wt start?)`);
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
  else console.log(`удалён worktree ${project}/${slug} (порт за веткой сохранён в реестре)`);
}

async function cmdUnlink() {
  const positional = args.filter((a) => !a.startsWith("--"));
  const { project, pos } = resolveProjectArg(positional, projCtx);
  const slug = pos[0];
  if (!project || !slug) die(singleRepo ? "usage: wt unlink <slug>" : "usage: wt unlink <project> <slug>");
  await removeLinks(orch, project!, slug!);
  if (json) console.log(JSON.stringify({ project, slug, unlinked: true }));
  else console.log(`unlink ${project}/${slug} — вернулся к settings.json/.env из репо (перезапусти: wt restart ${singleRepo ? slug : `${project} ${slug}`})`);
}

async function cmdLink() {
  const positional = args.filter((a) => !a.startsWith("--"));
  const { project, pos } = resolveProjectArg(positional, projCtx);
  const slug = pos[0];
  const lslug = pos[1];
  if (!project || !slug) die(singleRepo ? "usage: wt link <slug> [link-slug]" : "usage: wt link <project> <slug> [link-slug]");
  const dir = slug === BASE_SLUG ? projectDir(orch, project!, projectsDir) : worktreeDir(orch, project!, slug!);
  if (!existsSync(dir)) die(`нет worktree: ${project}/${slug} (создай: wt new ${singleRepo ? slug : `${project} ${slug}`})`);
  const outcomes = await applyLinks(orch, project!, slug!, lslug ?? slug!);
  if (json) return void console.log(JSON.stringify(outcomes));
  const matched = outcomes.filter((o) => o.status !== "skip-no-port");
  if (matched.length === 0) {
    console.log(`link: у ${project} нет настроенных/запущенных upstream'ов в LINKS`);
    return;
  }
  for (const o of outcomes) {
    if (o.status === "written") console.log(`link: ${project}/${slug}  ${o.key} → ${o.value}  (${o.target})`);
    else if (o.status === "skip-no-port") console.log(`link: пропуск ${project} → ${o.target} (нет worktree ${o.target}/${lslug ?? slug})`);
    else console.log(`link: ${project} — нет источника для ${o.key}, пропуск`);
  }
  console.log(`применить: wt restart ${singleRepo ? slug : `${project} ${slug}`}`);
}

async function parseStartOpts(pos: string[]): Promise<{ link?: "all" | string; linkSlug?: string }> {
  // pos — позиционные после resolveProjectArg: pos[0]=slug, pos[1]=link-slug.
  // Multi-repo: pos = positional.slice(1), поэтому pos[1] === старый positional[2] (parity).
  const o: { link?: "all" | string; linkSlug?: string } = {};
  if (rest.includes("--server")) {
    const srv = await resolveServerProject(orch);
    if (!srv) die("--server: в wt.config не задан serverProject (укажите проект-апстрим)");
    o.link = srv!;
  } else if (rest.includes("--link")) {
    o.link = "all";
  }
  if (pos[1]) o.linkSlug = pos[1];
  return o;
}

function reportStart(r: { project: string; slug: string; port: number; pid: number | null; container: string | null; portUp: boolean }) {
  const who = r.container ?? `PID ${r.pid}`;
  if (r.portUp) console.log(`started ${r.project}/${r.slug} — ${who}, поднялся на :${r.port} (wt logs ${r.project} ${r.slug} -f)`);
  else console.log(`started ${r.project}/${r.slug} — ${who}, НЕ поднялся в срок — см. wt logs ${r.project} ${r.slug}`);
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
  // не абортим: start сам снимет залипший контейнер и покажет причину, если не сможет
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

  console.log(`— снесу (${toSweep.length}):`);
  for (const i of toSweep) console.log("  " + line(i));
  console.log(`— пропускаю (${skipped.length}):`);
  for (const i of skipped) console.log("  " + line(i) + "  [" + i.reason + "]");
  const gb = toSweep.reduce((s, i) => s + i.diskBytes, 0);
  console.log(`итого: ${toSweep.length} worktree, ~${fmtGb(gb)} к освобождению`);

  if (!apply) {
    if (toSweep.length) console.log("dry-run — выполнить: wt sweep --apply");
    return;
  }
  for (const i of toSweep) {
    await sweepOne(orch, i);
    console.log(`снесён ${i.project}/${i.slug} (ветка ${i.branch}, MR !${i.mr})`);
  }
  console.log(`готово: снесено ${toSweep.length}, освобождено ~${fmtGb(gb)}`);
}

async function cmdSlim() {
  const apply = rest.includes("--apply");
  const plan = await collectSlimFacts(orch);
  if (json) return void console.log(JSON.stringify(plan));
  const { items, orphanVolumes } = plan;

  const toSlim = items.filter((i) => i.action === "slim").sort((a, b) => b.hostBytes - a.hostBytes);
  const running = items.filter((i) => i.reason === "running");
  console.log(`— почищу (${toSlim.length}):`);
  for (const i of toSlim)
    console.log("  " + col(i.project, 20) + " " + col(i.slug, 30) + " " + col(fmtGb(i.hostBytes), 6) +
      (i.volumes.length ? ` + томов: ${i.volumes.length}` : ""));
  if (running.length)
    console.log(`— запущены, не трогаю (${running.length}): ` + running.map((i) => `${i.project}/${i.slug}`).join(", "));
  if (orphanVolumes.length) {
    console.log(`— тома-сироты, worktree уже нет (${orphanVolumes.length}):`);
    for (const v of orphanVolumes) console.log("  " + v);
  }
  const gb = toSlim.reduce((s, i) => s + i.hostBytes, 0);
  const vols = toSlim.reduce((s, i) => s + i.volumes.length, 0) + orphanVolumes.length;
  console.log(`итого: ${toSlim.length} worktree, ~${fmtGb(gb)} на хосте + ${vols} docker-томов (размер не меряю)`);

  if (!apply) {
    if (toSlim.length || orphanVolumes.length) console.log("dry-run — выполнить: wt slim --apply");
    return;
  }
  const keptOrphans = await removeVolumes(orphanVolumes);
  console.log(`снесены тома-сироты: ${orphanVolumes.length - keptOrphans.length}` +
    (keptOrphans.length ? ` (заняты, оставлены: ${keptOrphans.join(", ")})` : ""));
  for (const i of toSlim) {
    const r = await slimOne(orch, i);
    if (r.started) {
      console.log(`пропущен ${i.project}/${i.slug}: успел запуститься`);
      continue;
    }
    const kept = r.keptVolumes.length ? ` (тома заняты, оставлены: ${r.keptVolumes.join(", ")})` : "";
    console.log(`почищен ${i.project}/${i.slug}${kept}`);
  }
  console.log(`готово: ~${fmtGb(gb)} на хосте; зависимости вернёт wt start`);
}

async function cmdReap() {
  const { removed } = await reapContainers(orch);
  if (json) return void console.log(JSON.stringify({ removed }));
  console.log(removed ? `reap: снесены все dev-контейнеры wtdev-* (${removed})` : "reap: dev-контейнеров не найдено");
}

const USAGE = `wt — управление много-веточной разработкой в ApartX-оркестраторе.

(single-repo workspace: опускайте <project> — он подразумевается, напр. \`wt new <slug>\`)

Команды (slug опционален: без него = базовый checkout projects/<p>, slug "base"):
  new   <p> <slug> [--isolated-db [--seed]]   создать worktree+ветку+install+env
  run   <p> [slug] [--link|--server [slug]]   запустить в foreground (Ctrl-C, только host-проекты)
  start <p> [slug] [--link|--server [slug]]   запустить в фоне (host: pidfile+log / dockerized: контейнер)
  stop  <p> [slug] | --all                    остановить инстанс / все
  restart <p> [slug]                          stop + start
  up                                          поднять core-набор (server+cabinet+admin)
  down                                        остановить все
  ps    [--json]                              запущенные инстансы
  list  [--json]                              существующие worktree
  logs  <p> [slug] [-f] | --all               логи фонового инстанса(ов)
  link  <p> <slug> [slug]                     связать со всеми worktree-upstream'ами (меш LINKS)
  unlink <p> <slug>                           вернуть settings.json/.env из репозитория
  rm    <p> <slug> [--branch]                 снести worktree (+опц. ветку)
  reap                                        снести все dev-контейнеры wtdev-*
  sweep [--apply] [--json]                    снести worktree со смерженными в GitLab ветками (без --apply = план)
  slim  [--apply] [--json]                    снести node_modules/.meteor/local/docker-тома во всех остановленных worktree + тома-сироты (без --apply = план)
  port  <p> [slug] [--json]                   напечатать выданный порт
  projects [--json]                           список проектов
  ui                                          полноэкранный TUI-дашборд (нужен bun)
  web                                         web-дашборд SvelteKit+apartx-ui (нужен bun)
  version | --version                         версия wt
`;

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
  help: cmdHelp,
  "--help": cmdHelp,
  "-h": cmdHelp,
};
const handler = cmd ? table[cmd] : cmdHelp; // без команды → help
if (handler) {
  // Без этого любой throw из ядра доезжал до пользователя стеком Bun, а сообщение
  // (причина отказа docker) тонуло. WT_DEBUG=1 возвращает стек.
  try {
    if (handler !== cmdHelp) await loadWorkspace();
    await handler();
  } catch (e) {
    if (process.env.WT_DEBUG) console.error(e);
    die(e instanceof Error ? e.message : String(e));
  }
} else {
  process.stderr.write(`wt: неизвестная команда: ${cmd}\n`);
  process.stdout.write(USAGE);
  process.exit(1);
}
