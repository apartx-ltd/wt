import { unlink, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { readWorktreePort, readEnvValue } from "./ports";
import { ovrFilePath, envFilePath, worktreeDir, projectDir } from "./paths";
import { resolveLinkSpecs, resolveProjectsDir } from "./config";

export type LinkMechanism = "env" | "settings";

export interface Link {
  consumer: string;
  target: string;
  mechanism: LinkMechanism;
  key: string;
}

/** Разбор одной строки `consumer:target:mechanism:key`. */
export function parseLinkSpec(spec: string): Link {
  const [consumer, target, mechanism, key] = spec.split(":");
  return { consumer, target, mechanism: mechanism as LinkMechanism, key };
}

/** Все upstream-линки потребителя из набора спеков (резолв; применение слоёв — applyLinks). */
export function resolveLinks(specs: readonly string[], consumer: string): Link[] {
  return specs.map(parseLinkSpec).filter((l) => l.consumer === consumer);
}

/** `wt unlink`: убрать env/settings-слои линка → вернуться к репо-дефолтам. Паритет cmd_unlink. */
export async function removeLinks(orch: string, project: string, slug: string): Promise<void> {
  await unlink(ovrFilePath(orch, project, slug)).catch(() => {});
  await unlink(envFilePath(orch, project, slug)).catch(() => {});
}

/** Заменить порт в `:NNNN(/|конец)` на `:port`. Паритет port_swap (sed). */
export function portSwap(value: string, port: number): string {
  return value.replace(/:[0-9]+(\/|$)/, `:${port}$1`);
}

/** Upsert строки `key=value` в содержимое env-слоя (выкинуть прежние `^key=`, дописать). Паритет write_env_link. */
export function upsertEnvLine(content: string, key: string, value: string): string {
  const lines = content.length ? content.split("\n") : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const kept = lines.filter((l) => !l.startsWith(`${key}=`));
  kept.push(`${key}=${value}`);
  return kept.join("\n") + "\n";
}

/** Port-swap листа по dotted-пути в settings-объекте (мутирует+возвращает). Кидает если путь отсутствует. Паритет node-вставки write_settings_link. */
export function setSettingsPort(json: any, keyPath: string, port: number): any {
  const ks = keyPath.split(".");
  let o = json;
  for (let i = 0; i < ks.length - 1; i++) {
    if (o[ks[i]] == null) throw new Error(`нет ${keyPath}`);
    o = o[ks[i]];
  }
  const last = ks[ks.length - 1];
  if (o[last] == null) throw new Error(`нет ${keyPath}`);
  o[last] = portSwap(String(o[last]), port);
  return json;
}

export type LinkStatus = "written" | "skip-no-port" | "skip-no-source";
export interface LinkOutcome {
  target: string;
  mechanism: LinkMechanism;
  key: string;
  status: LinkStatus;
  /** для env-written — новое значение; для settings-written — `:port` */
  value?: string;
}

async function writeEnvLink(
  orch: string,
  consumer: string,
  slug: string,
  key: string,
  port: number,
  projectsDir: string,
): Promise<{ status: LinkStatus; value?: string }> {
  const cur = await readEnvValue(resolve(projectDir(orch, consumer, projectsDir), ".env"), key);
  if (!cur) return { status: "skip-no-source" };
  const newval = portSwap(cur, port);
  const f = envFilePath(orch, consumer, slug);
  await mkdir(dirname(f), { recursive: true });
  const content = existsSync(f) ? await readFile(f, "utf8") : "";
  await writeFile(f, upsertEnvLine(content, key, newval));
  return { status: "written", value: newval };
}

async function writeSettingsLink(
  orch: string,
  consumer: string,
  slug: string,
  keyPath: string,
  port: number,
): Promise<{ status: LinkStatus; value?: string }> {
  const dir = worktreeDir(orch, consumer, slug);
  let src = "";
  if (existsSync(resolve(dir, "settings", "settings.json"))) src = resolve(dir, "settings", "settings.json");
  else if (existsSync(resolve(dir, "settings.json"))) src = resolve(dir, "settings.json");
  if (!src) return { status: "skip-no-source" };
  const out = ovrFilePath(orch, consumer, slug);
  const from = existsSync(out) ? out : src; // копим несколько settings-линков в одном override
  const json = JSON.parse(await readFile(from, "utf8"));
  setSettingsPort(json, keyPath, port);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(json, null, 2) + "\n");
  return { status: "written", value: `:${port}` };
}

/**
 * `wt link`: применить env/settings-слои для апстримов consumer'а. Порт цели берётся
 * из её `.env.worktree` (`lslug`-worktree). `filter` ограничивает одной целью
 * (start --server). Паритет apply_links. НЕ кидает (решение по выводу — у вызывающего).
 */
export async function applyLinks(
  orch: string,
  consumer: string,
  slug: string,
  lslug: string,
  filter?: string,
): Promise<LinkOutcome[]> {
  const out: LinkOutcome[] = [];
  const specs = await resolveLinkSpecs(orch);
  const projectsDir = await resolveProjectsDir(orch);
  for (const link of resolveLinks(specs, consumer)) {
    if (filter && link.target !== filter) continue;
    const port = await readWorktreePort(worktreeDir(orch, link.target, lslug));
    if (port === null) {
      out.push({ target: link.target, mechanism: link.mechanism, key: link.key, status: "skip-no-port" });
      continue;
    }
    const r =
      link.mechanism === "env"
        ? await writeEnvLink(orch, consumer, slug, link.key, port, projectsDir)
        : await writeSettingsLink(orch, consumer, slug, link.key, port);
    out.push({ target: link.target, mechanism: link.mechanism, key: link.key, status: r.status, value: r.value });
  }
  return out;
}
