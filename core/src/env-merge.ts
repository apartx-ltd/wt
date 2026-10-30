/** Parse .env text: `KEY=VALUE` per line, strip surrounding quotes, ignore `#`/empty lines.
 *  Supports shell-style `export KEY=VALUE` (the leading `export ` is stripped). */
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

/** Merge env files into a map: each next file overrides the previous ones; missing files are skipped. */
export async function mergeEnvFiles(files: string[]): Promise<Record<string, string>> {
  const acc = new Map<string, string>();
  for (const file of files) {
    const f = Bun.file(file);
    if (!(await f.exists())) continue;
    for (const [k, v] of parseEnvFile(await f.text())) acc.set(k, v);
  }
  return Object.fromEntries(acc);
}
