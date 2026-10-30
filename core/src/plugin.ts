import type { ResolvedProjectConfig } from "./config";

/**
 * Версия контракта StackPlugin↔core. Бамп — при несовместимом изменении интерфейса
 * (новое обязательное поле/смена семантики ctx). loadPlugin отказывает плагину с другой
 * версией: при OSS обновление ядра не должно молча ломать сторонний плагин.
 */
export const PLUGIN_API_VERSION = 1;

/** Команда, которую ИСПОЛНЯЕТ ядро (плагин только описывает). */
export interface Command {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * Дескриптор детерминированного доп-порта. Плагин даёт базу и (опц.) env-ключ
 * переопределения; ЯДРО аллоцирует конкретный порт (база + индекс проекта среди
 * dockerized + worktree-offset) и кладёт в ctx.extraPorts[name]. Имя стека (hmr,
 * RSPACK_DEVSERVER_PORT, 8085) живёт здесь, в плагине, не в ядре.
 */
export interface ExtraPortSpec {
  /** ключ в ctx.extraPorts (meteor: "hmr"). */
  name: string;
  /** детерминированная база, когда envKey не задан в .env (meteor: 8085). */
  basePort: number;
  /** опц. env-ключ переопределения базы из <projectDir>/.env (meteor: "RSPACK_DEVSERVER_PORT"). */
  envKey?: string;
}

/** Базовый контекст: всё, что ядро знает о (project, slug) до запуска. */
export interface PluginCtx {
  orch: string;
  project: string;
  slug: string;
  branch: string;
  projectDir: string;
  worktreeDir: string;
  config: ResolvedProjectConfig;
}

/** Контекст создания worktree (`wt new`): порты ещё не нужны. */
export type WorktreeCtx = PluginCtx;

/** Контекст запущенного инстанса: порты посчитаны, имя контейнера известно. */
export interface InstanceCtx extends PluginCtx {
  port: number;
  offset: number;
  container: string;
  /** режим запуска — определяет, как плагин выражает порт и синтаксис флагов. */
  mode: "host" | "docker";
  /** путь к settings-файлу для devCommand (ядро вычисляет per-mode: host=абс/репо, docker=".wt-settings.json"); null если нет. */
  settingsPath?: string | null;
  /** доп-порты по именам из plugin.extraPorts (ядро посчитало детерминированно). */
  extraPorts: Record<string, number>;
}

/** Контекст генерации env-строк. */
export interface EnvCtx extends InstanceCtx {}

/** Контекст сидинга isolated-db. */
export interface SeedCtx extends InstanceCtx {
  /** базовый URL БД (из urlEnvKey в .env проекта). */
  baseDbUrl: string;
  /** целевой изолированный URL (deriveUrl(baseDbUrl, suffix)). */
  isolatedDbUrl: string;
  /** исполнитель команд от ядра (seam): плагин строит argv, ядро запускает. */
  run(argv: string[]): Promise<void>;
}

/**
 * Контракт адаптера стека. Плагин ОПИСЫВАЕТ (argv/строки/url), ядро ИСПОЛНЯЕТ.
 * См. design.md → StackPlugin.
 */
export interface StackPlugin {
  name: string;
  /**
   * Версия контракта, на который собран плагин. Обязательна при загрузке через loadPlugin
   * (бандл-плагины её ставят); тип опционален лишь чтобы инлайновые тест-фейки, минующие
   * loadPlugin, компилировались. Несовпадение с PLUGIN_API_VERSION ⇒ loadPlugin кидает.
   */
  apiVersion?: number;
  /** "dotenvx" → ядро оборачивает devCommand в dotenvx-цепочку; "inline" (дефолт) → env-словарём. */
  envInjection?: "dotenvx" | "inline";
  install(ctx: WorktreeCtx): Command;
  /** каталоги worktree (отн. корня), которые восстанавливают install/сборка — их сносит `wt slim`. */
  artifactDirs?: string[];
  devCommand(ctx: InstanceCtx): Command;
  envLines?(ctx: EnvCtx): string[];
  /** статические строки в конец `.env.worktree` (после ROOT_URL); пусто ⇒ ничего. */
  worktreeEnvTail?(ctx: WorktreeCtx): string[];
  /** доп-порты: ядро аллоцирует по одному на каждый spec (→ ctx.extraPorts[spec.name]). */
  extraPorts?: ExtraPortSpec[];
  resolveBasePort?(projectDir: string): Promise<number | null>;
  settingsFile?(ctx: InstanceCtx): string;
  isolatedDb?: {
    /** env-ключ, держащий БД-URL (meteor: "MONGO_URL"). */
    urlEnvKey: string;
    deriveUrl(baseUrl: string, suffix: string): string;
    seed?(ctx: SeedCtx): Promise<void>;
  };
  docker?(ctx: InstanceCtx): {
    mounts: string[];
    addHosts?: string[];
    ownedVolumes?: string[];
    /** статические `-e KEY=VALUE` для `docker run` (порядок вставки сохраняется). */
    env?: Record<string, string>;
    /** per-line трансформ merged-env ПОСЛЕ generic localhost→host remap ядра. */
    envLineFilter?: (line: string) => string;
  };
}

/**
 * `envLineFilter` для Mongo-URL: дописывает `directConnection=true`.
 *
 * Dev-Mongo поднят как replica set, поэтому драйвер после seed-хоста берёт адреса из
 * конфига реплики — а там `127.0.0.1`, который внутри контейнера указывает на сам
 * контейнер (ECONNREFUSED). `directConnection` выключает discovery и оставляет драйвер
 * на том хосте, что в URL. Нужен любому dockerized-стеку, ходящему в общий dev-Mongo,
 * поэтому живёт в ядре, а не в отдельном плагине.
 */
export const mongoDirectConnectionFilter = (line: string): string =>
  /^MONGO(_OPLOG)?_URL=mongodb/.test(line) && !line.includes("directConnection=")
    ? line + (line.includes("?") ? "&" : "?") + "directConnection=true"
    : line;

const REGISTRY = new Map<string, StackPlugin>();

/** Зарегистрировать бандл-плагин под именем пакета. Вызывается из bootstrap'а (Task 11) и тестов. */
export function registerPlugin(name: string, plugin: StackPlugin): void {
  REGISTRY.set(name, plugin);
}

/**
 * Прежние приватные workspace-имена плагинов → публичные specifier'ы. Старое имя не
 * резолвится молча: конфиг пользователя должен быть обновлён явно.
 */
const LEGACY_PLUGIN_IDS: Record<string, string> = {
  "@wt/plugin-meteor": "@apartx/wt/plugin-meteor",
  "@wt/plugin-node": "@apartx/wt/plugin-node",
};

/**
 * Загрузить плагин по имени пакета. Сейчас — только из реестра бандл-плагинов
 * (M0–M3); npm-резолв — открытый вопрос M4 (design.md).
 */
export async function loadPlugin(name: string): Promise<StackPlugin> {
  const renamed = LEGACY_PLUGIN_IDS[name];
  if (renamed) throw new Error(`plugin: "${name}" was renamed to "${renamed}" — update "plugin" in wt.config.ts`);
  const p = REGISTRY.get(name);
  if (!p) throw new Error(`plugin: неизвестный плагин: ${name} (зарегистрированы: ${[...REGISTRY.keys()].join(", ") || "—"})`);
  if (p.apiVersion !== PLUGIN_API_VERSION) {
    throw new Error(
      `plugin: ${name} несовместим: apiVersion=${p.apiVersion ?? "не задан"}, ядру нужен ${PLUGIN_API_VERSION}`,
    );
  }
  return p;
}
