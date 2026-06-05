// Symbol + color helpers that mirror @clack/prompts' own treatment so the custom
// multiselect (controlMultiselect in tui.ts) matches the native select() prompts.
// @clack doesn't export its symbols or color, so we re-derive them here: the same
// Unicode-or-ASCII fallback, and tiny dependency-free ANSI color that honors NO_COLOR
// and non-TTY output. Keeps the bundle at zero runtime deps (see CLAUDE.md / Stack).
import process from "node:process";

// Mirror of @clack's is-unicode-supported heuristic: most terminals are fine; the
// Linux VT console and bare Windows consoles are the ones that need ASCII fallback.
function unicodeSupported(): boolean {
  if (process.platform !== "win32") return process.env.TERM !== "linux";
  return (
    Boolean(process.env.WT_SESSION) ||
    Boolean(process.env.TERMINUS_SUBLIME) ||
    process.env.ConEmuTask === "{cmd::Cmder}" ||
    process.env.TERM_PROGRAM === "Terminus-Sublime" ||
    process.env.TERM_PROGRAM === "vscode" ||
    process.env.TERM === "xterm-256color" ||
    process.env.TERM === "alacritty" ||
    process.env.TERMINAL_EMULATOR === "JetBrains-JediTerm"
  );
}

const unicode = unicodeSupported();
const pick = (u: string, a: string) => (unicode ? u : a);

// Same glyphs @clack uses, plus a group glyph + scroll/filter affordances of our own.
export const S = {
  active: pick("◆", "*"),
  submit: pick("◇", "o"),
  cancel: pick("■", "x"),
  error: pick("▲", "x"),
  bar: pick("│", "|"),
  barEnd: pick("└", "—"),
  checkboxOn: pick("◼", "[+]"),
  checkboxOff: pick("◻", "[ ]"),
  pointer: pick("❯", ">"),
  group: pick("◈", "+"),
  up: pick("↑", "^"),
  down: pick("↓", "v"),
};

const colorOn =
  !("NO_COLOR" in process.env) && process.env.TERM !== "dumb" && Boolean(process.stdout.isTTY);

const sgr = (open: number, close: number) => (s: string) =>
  colorOn ? `\x1b[${open}m${s}\x1b[${close}m` : s;

export const c = {
  cyan: sgr(36, 39),
  green: sgr(32, 39),
  red: sgr(31, 39),
  yellow: sgr(33, 39),
  dim: sgr(2, 22),
  bold: sgr(1, 22),
  gray: sgr(90, 39),
  inverse: sgr(7, 27),
};
