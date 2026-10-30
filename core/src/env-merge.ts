/** Распарсить текст .env: `KEY=VALUE` построчно, снять обрамляющие кавычки, игнор `#`/пустых.
 *  Поддерживает shell-стиль `export KEY=VALUE` (ведущий `export ` снимается). */
export function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const val = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
    out.set(key, val);
  }
  return out;
}

/** Слить env-файлы в словарь: каждый следующий перекрывает предыдущие; отсутствующие пропускаются. */
export async function mergeEnvFiles(files: string[]): Promise<Record<string, string>> {
  const acc = new Map<string, string>();
  for (const file of files) {
    const f = Bun.file(file);
    if (!(await f.exists())) continue;
    for (const [k, v] of parseEnvFile(await f.text())) acc.set(k, v);
  }
  return Object.fromEntries(acc);
}
