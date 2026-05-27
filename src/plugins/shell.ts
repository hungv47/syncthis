import { realpath, rm, stat } from "node:fs/promises";

export type ShellResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  cmd: string;
  notFound: boolean;
};

const DEFAULT_TIMEOUT_MS = 15_000;

export async function run(cmd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<ShellResult> {
  const display = [cmd, ...args].join(" ");
  try {
    const proc = Bun.spawn([cmd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    const timeout = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timeout);
    return {
      ok: exitCode === 0,
      exitCode,
      stdout,
      stderr,
      cmd: display,
      notFound: false,
    };
  } catch (err) {
    const message = (err as { message?: string })?.message ?? String(err);
    const notFound = /ENOENT|not found|No such file/i.test(message);
    return { ok: false, exitCode: -1, stdout: "", stderr: message, cmd: display, notFound };
  }
}

// Split a plugin id of the form "<name>@<marketplace>" into its parts. A leading
// `@` (e.g. npm scope "@scope/pkg") is preserved as part of the name.
export function parsePluginId(id: string): { name: string; marketplace?: string } {
  const at = id.lastIndexOf("@");
  if (at <= 0) return { name: id };
  return { name: id.slice(0, at), marketplace: id.slice(at + 1) };
}

// Plugin / marketplace names that may flow into path construction must be flat
// identifiers — no path separators, no traversal, no NUL. This is enforced BEFORE
// any join() so that even though safeRmUnder catches escape outside the anchor,
// a name like "../cache/sibling" cannot redirect deletion to a sibling subtree
// inside the same anchor.
export function isSafeIdentifier(name: string): boolean {
  if (!name) return false;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("..")) return false;
  return true;
}

export function assertSafeIdentifier(name: string, label = "name"): void {
  if (!isSafeIdentifier(name)) {
    throw new Error(`${label} contains unsafe characters or path traversal: ${JSON.stringify(name)}`);
  }
}

// Containment-checked rm -rf. Resolves both target and anchor via realpath, then
// refuses to delete anything that doesn't sit under anchor. Returns {removed, message}.
// Missing target → {removed: false, message: "absent"}. Used for --purge sweeps where
// we MUST never escape the agent's plugins/cache tree.
//
// TOCTOU note: we realpath both sides, verify containment, then rm the CANONICAL
// target (not the original path). This closes a window where a path component
// could be swapped to a symlink between check and rm.
export async function safeRmUnder(
  target: string,
  anchor: string,
): Promise<{ removed: boolean; message?: string }> {
  let canonicalAnchor: string;
  try {
    canonicalAnchor = await realpath(anchor);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      return { removed: false, message: "anchor missing" };
    }
    return { removed: false, message: `anchor unresolvable: ${(err as Error).message}` };
  }
  let canonicalTarget: string;
  try {
    canonicalTarget = await realpath(target);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      return { removed: false, message: "absent" };
    }
    return { removed: false, message: `target unresolvable: ${(err as Error).message}` };
  }
  if (canonicalTarget === canonicalAnchor) {
    return { removed: false, message: "refusing to delete anchor itself" };
  }
  if (!canonicalTarget.startsWith(`${canonicalAnchor}/`)) {
    return { removed: false, message: `outside anchor (${canonicalAnchor}): ${canonicalTarget}` };
  }
  try {
    const info = await stat(canonicalTarget);
    if (!info.isDirectory()) {
      return { removed: false, message: "not a directory" };
    }
  } catch (err) {
    return { removed: false, message: (err as Error).message };
  }
  await rm(canonicalTarget, { recursive: true, force: true });
  return { removed: true };
}
