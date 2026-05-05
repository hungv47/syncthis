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
  await mkdir(dirname(path), { recursive: true });
  if (await isSymlink(path)) {
    throw new Error(`syncthis: target is a symlink, refusing to write through it: ${path}`);
  }
  if (opts?.backup) await backupIfExists(path);
  await writeRestrictive(path, JSON.stringify(data, null, 2) + "\n");
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
  await mkdir(dirname(path), { recursive: true });
  if (await isSymlink(path)) {
    throw new Error(`syncthis: target is a symlink, refusing to write through it: ${path}`);
  }
  if (opts?.backup) await backupIfExists(path);
  await writeRestrictive(path, text);
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
  if (preserved !== null) await chmod(path, preserved);
}

export async function backupIfExists(path: string) {
  const bakPath = `${path}.syncthis.bak`;
  if (await isSymlink(bakPath)) {
    throw new Error(`syncthis: refusing to write backup through a symlink: ${bakPath}`);
  }
  try {
    await copyFile(path, bakPath, 1 /* COPYFILE_EXCL */);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "EEXIST" || code === "ENOENT") return;
    throw err;
  }
}

export function expandHome(path: string): string {
  if (path !== "~" && !path.startsWith("~/")) return path;
  const home = process.env.HOME ?? homedir();
  return path.replace(/^~/, home);
}

function isNotFound(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "ENOENT";
}
