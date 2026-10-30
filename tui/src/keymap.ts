export type Action =
  | "up" | "down" | "quit" | "start" | "stop" | "restart" | "rm" | "new" | "link" | "unlink";

export type Confirm = "confirm" | "confirmBranch" | "cancel";

// Modal confirm keys (ConfirmRm). Latin + ru positional (physical y/n/b → н/т/и).
const CONFIRM = new Set(["y", "н"]); //          y / ru н (physical Y)
const CONFIRM_BRANCH = new Set(["b", "и"]); //   b / ru и (physical B)
const CANCEL = new Set(["n", "т", "escape", "q", "й"]); // n/Esc/q / ru т,й

/** Resolve a key inside a yes/no confirm modal. Returns null for unmapped keys. */
export function resolveConfirm(name: string): Confirm | null {
  if (CONFIRM.has(name)) return "confirm";
  if (CONFIRM_BRANCH.has(name)) return "confirmBranch";
  if (CANCEL.has(name)) return "cancel";
  return null;
}

// OpenTUI reports key.name as the *produced character*, which depends on the OS
// keyboard layout. So we key off layout-independent names (arrows, escape) as the
// primary controls, and add the Latin letters plus their Russian ЙЦУКЕН-layout
// positional equivalents (same physical key) as conveniences.
const DOWN = new Set(["down", "j", "о"]); //    ↓ / vim j / ru о (physical J)
const UP = new Set(["up", "k", "л"]); //        ↑ / vim k / ru л (physical K)
const QUIT = new Set(["escape", "q", "й"]); //  Esc / q / ru й (physical Q)
const START = new Set(["s", "ы"]); //           s / ru ы (physical S)
const STOP = new Set(["x", "ч"]); //            x / ru ч (physical X)
const RESTART = new Set(["r", "к"]); //         r / ru к (physical R)
const RM = new Set(["d", "в"]); //              d / ru в (physical D)
const NEW = new Set(["n", "т"]); //             n / ru т (physical N)
const LINK = new Set(["l", "д"]); //            l / ru д (physical L)
const UNLINK = new Set(["u", "г"]); //          u / ru г (physical U)

export function resolveKey(name: string, mods?: { ctrl?: boolean }): Action | null {
  if (mods?.ctrl && (name === "c" || name === "с")) return "quit"; // Ctrl-C (en/ru)
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
