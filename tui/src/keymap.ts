export type Action =
  | "up" | "down" | "quit" | "start" | "stop" | "restart" | "rm" | "new" | "link" | "unlink";

export type Confirm = "confirm" | "confirmBranch" | "cancel";

// Modal confirm keys (ConfirmRm). Latin + ru positional (physical y/n/b → the ru letters
// on the same keys). Cyrillic letters are written as \u{…} escapes (same runtime strings) so the
// source stays English-only text.
const CONFIRM = new Set(["y", "\u{43d}"]); //          y / ru (physical Y)
const CONFIRM_BRANCH = new Set(["b", "\u{438}"]); //   b / ru (physical B)
const CANCEL = new Set(["n", "\u{442}", "escape", "q", "\u{439}"]); // n/Esc/q / ru (physical N, Q)

/** Resolve a key inside a yes/no confirm modal. Returns null for unmapped keys. */
export function resolveConfirm(name: string): Confirm | null {
  if (CONFIRM.has(name)) return "confirm";
  if (CONFIRM_BRANCH.has(name)) return "confirmBranch";
  if (CANCEL.has(name)) return "cancel";
  return null;
}

// OpenTUI reports key.name as the *produced character*, which depends on the OS
// keyboard layout. So we key off layout-independent names (arrows, escape) as the
// primary controls, and add the Latin letters plus their Russian JCUKEN-layout
// positional equivalents (same physical key) as conveniences.
const DOWN = new Set(["down", "j", "\u{43e}"]); //    ↓ / vim j / ru (physical J)
const UP = new Set(["up", "k", "\u{43b}"]); //        ↑ / vim k / ru (physical K)
const QUIT = new Set(["escape", "q", "\u{439}"]); //  Esc / q / ru (physical Q)
const START = new Set(["s", "\u{44b}"]); //           s / ru (physical S)
const STOP = new Set(["x", "\u{447}"]); //            x / ru (physical X)
const RESTART = new Set(["r", "\u{43a}"]); //         r / ru (physical R)
const RM = new Set(["d", "\u{432}"]); //              d / ru (physical D)
const NEW = new Set(["n", "\u{442}"]); //             n / ru (physical N)
const LINK = new Set(["l", "\u{434}"]); //            l / ru (physical L)
const UNLINK = new Set(["u", "\u{433}"]); //          u / ru (physical U)

export function resolveKey(name: string, mods?: { ctrl?: boolean }): Action | null {
  if (mods?.ctrl && (name === "c" || name === "\u{441}")) return "quit"; // Ctrl-C (en/ru)
  if (DOWN.has(name)) return "down";
  if (UP.has(name)) return "up";
  if (QUIT.has(name)) return "quit";
  if (START.has(name)) return "start";
  if (STOP.has(name)) return "stop";
  if (RESTART.has(name)) return "restart";
  if (RM.has(name)) return "rm";
  if (NEW.has(name)) return "new";
  if (LINK.has(name)) return "link";
  if (UNLINK.has(name)) return "unlink";
  return null;
}
