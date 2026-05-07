import { mkdir, lstat, copyFile, writeFile, chmod, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";

export async function readJson<T = unknown>(path: string): Promise<T | null> {
  try {
    const text = await Bun.file(path).text();
    if (!text.trim()) return {} as T;
    return JSON.parse(text) as T;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function writeJson(path: string, data: unknown, opts?: { backup?: boolean }) {
  await writeSafe(path, JSON.stringify(data, null, 2) + "\n", opts);
}

export async function readText(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function writeText(path: string, text: string, opts?: { backup?: boolean }) {
  await writeSafe(path, text, opts);
}

async function writeSafe(path: string, content: string | Uint8Array, opts?: { backup?: boolean }) {
  await mkdir(dirname(path), { recursive: true });
  if (await isSymlink(path)) {
    throw new Error(`syncthis: target is a symlink, refusing to write through it: ${path}`);
  }
  if (opts?.backup) await backupIfExists(path);
  await writeRestrictive(path, content);
}

async function isSymlink(p: string): Promise<boolean> {
  try {
    return (await lstat(p)).isSymbolicLink();
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

async function writeRestrictive(path: string, content: string | Uint8Array) {
  let preserved: number | null = null;
  try {
    preserved = (await stat(path)).mode & 0o777;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await writeFile(path, content, { mode: 0o600 });
  if (preserved !== null) await chmod(path, preserved & 0o600);
}

export async function backupIfExists(path: string) {
  const bakPath = `${path}.syncthis.bak`;
  if (await isSymlink(bakPath)) {
    throw new Error(`syncthis: refusing to write backup through a symlink: ${bakPath}`);
  }
  // Sacred element §2: backup on FIRST write. If a bak already exists, preserve it —
  // never rotate the user's original out of existence on subsequent writes.
  try {
    await stat(bakPath);
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  try {
    await copyFile(path, bakPath);
    await chmod(bakPath, 0o600);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return;
    throw err;
  }
}

export function expandHome(path: string): string {
  if (path !== "~" && !path.startsWith("~/")) return path;
  const home = process.env.HOME ?? homedir();
  return path.replace(/^~/, home);
}

// For env-var-overridable adapter paths ($COPILOT_HOME, $OPENCLAW_CONFIG_PATH, etc.):
// expand `~` if present and assert the resolved path is anchored under $HOME so a malicious
// or accidentally-set env var can't redirect syncthis writes to arbitrary filesystem locations.
export function resolveUnderHome(p: string, varName: string): string {
  const home = process.env.HOME ?? homedir();
  const expanded = expandHome(p);
  // Resolve to absolute. If `expanded` is relative, treat it as relative to $HOME.
  const abs = expanded.startsWith("/") ? expanded : `${home}/${expanded}`;
  // Reject paths containing `..` segments after resolution (defense-in-depth — Node's path.resolve
  // would normalize these but we want to refuse them outright as a signal of misuse).
  if (abs.split("/").includes("..")) {
    throw new Error(`syncthis: ${varName} must not contain '..' segments: ${p}`);
  }
  if (abs !== home && !abs.startsWith(`${home}/`)) {
    throw new Error(`syncthis: ${varName} must resolve under $HOME, got ${abs}`);
  }
  return abs;
}

function isNotFound(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "ENOENT";
}
