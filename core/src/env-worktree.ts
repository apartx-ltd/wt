/** Суффикс БД из имени ветки: убрать `^<type>/`, не-алфанум → `_`. Паритет worktree-env.sh. */
export function branchDbSuffix(branch: string): string {
  return branch.replace(/^[a-z]+\//, "").replace(/[^a-zA-Z0-9]+/g, "_");
}

export interface EnvWorktreeArgs {
  project: string;
  branch: string;
  offset: number;
  basePort: number;
  /** plugin-строки после PORT (meteor: RSPACK/HMR). */
  extraEnvLines?: string[];
  baseRootUrl: string;
  /** plugin-строки после ROOT_URL (meteor: MONGO_OPLOG_URL=, MONTI_*, isolated <urlEnvKey>=…). */
  tailLines?: string[];
}

/** Построить ROOT_URL с новым портом, сохраняя хост из базового ROOT_URL. */
export function rootUrlWithPort(baseRootUrl: string, port: number): string {
  const u = new URL(baseRootUrl);
  return `${u.protocol}//${u.hostname}:${port}`;
}

/** Содержимое `.env.worktree`. */
export function generateEnvWorktree(a: EnvWorktreeArgs): string {
  const port = a.basePort + a.offset;
  const rootUrl = rootUrlWithPort(a.baseRootUrl, port);
  const lines = [
    "# СГЕНЕРИРОВАНО scripts/worktree-env.sh — НЕ редактировать вручную",
    `# project=${a.project}  branch=${a.branch}  offset=${a.offset}`,
    `PORT=${port}`,
  ];
  for (const line of a.extraEnvLines ?? []) lines.push(line);
  lines.push(`ROOT_URL=${rootUrl}`);
  for (const line of a.tailLines ?? []) lines.push(line);
  return lines.join("\n") + "\n";
}
