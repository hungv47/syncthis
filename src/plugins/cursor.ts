import { readdir, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { expandHome } from "../io.ts";
import { parsePluginId } from "./shell.ts";
import type {
  PluginAdapter,
  PluginAdapterRead,
  PluginRecord,
  PluginRemoveOpts,
  PluginRemoveResult,
} from "./types.ts";

const PLUGINS_DIR = "~/.cursor/plugins";

// Directory names under ~/.cursor/plugins that represent install scopes/caches
// rather than installable plugin owners. We descend into these but don't list
// them as plugins themselves.
const SCOPE_DIRS = new Set(["local", "user", "cache", "project"]);

function resolvedConfigPath(): string {
  return expandHome(PLUGINS_DIR);
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function listSubdirs(p: string): Promise<string[]> {
  try {
    const entries = await readdir(p, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export const cursorPluginAdapter: PluginAdapter = {
  id: "cursor",
  pluginKind: "bundle",
  // Cursor has no first-class marketplace concept; npx plugins writes files
  // here but there's no registry to mirror. Surface as unsupported.
  supportsMarketplaces: false,
  configPath: resolvedConfigPath,
  async read(): Promise<PluginAdapterRead> {
    const root = resolvedConfigPath();
    const base: PluginAdapterRead = {
      agent: "cursor",
      configPath: root,
      exists: false,
      supportsPlugins: true,
      supportsMarketplaces: false,
      pluginKind: "bundle",
      plugins: [],
      marketplaces: [],
    };

    if (!(await isDir(root))) return base;

    const plugins: PluginRecord[] = [];
    const topLevel = await listSubdirs(root);

    for (const entry of topLevel) {
      const entryPath = join(root, entry);
      if (SCOPE_DIRS.has(entry)) {
        // Scope dir: descend one level. Names inside are plugin owners or names.
        const inner = await listSubdirs(entryPath);
        for (const owner of inner) {
          const ownerPath = join(entryPath, owner);
          const named = await listSubdirs(ownerPath);
          if (named.length === 0) {
            plugins.push({ name: owner, scope: entry, path: ownerPath, kind: "bundle" });
            continue;
          }
          for (const name of named) {
            plugins.push({
              name,
              marketplace: owner,
              scope: entry,
              path: join(ownerPath, name),
              kind: "bundle",
            });
          }
        }
      } else {
        // Treat top-level non-scope dir as an owner with plugins under it
        // (matches npx plugins' cache layout: <marketplace>/<plugin>/<sha>/).
        const named = await listSubdirs(entryPath);
        if (named.length === 0) {
          plugins.push({ name: entry, path: entryPath, kind: "bundle" });
          continue;
        }
        for (const name of named) {
          plugins.push({
            name,
            marketplace: entry,
            path: join(entryPath, name),
            kind: "bundle",
          });
        }
      }
    }

    return { ...base, exists: true, plugins };
  },

  async removePlugin(name: string, opts: PluginRemoveOpts): Promise<PluginRemoveResult> {
    const root = resolvedConfigPath();
    const read = await this.read();
    if (read.error) return { agent: "cursor", target: name, status: "failed", message: read.error };
    const { name: bare, marketplace: explicitMkt } = parsePluginId(name);
    const matches = read.plugins.filter((p) => p.name === bare && (!explicitMkt || p.marketplace === explicitMkt));
    if (matches.length === 0) return { agent: "cursor", target: name, status: "absent" };
    if (matches.length > 1) {
      return {
        agent: "cursor",
        target: name,
        status: "failed",
        message: `ambiguous — found under multiple scopes/owners: ${matches.map((m) => m.marketplace ?? m.scope ?? "?").join(", ")}. Disambiguate with <name>@<owner>.`,
      };
    }
    const match = matches[0]!;
    const path = match.path;
    if (!path) return { agent: "cursor", target: name, status: "failed", message: "no path recorded for plugin" };

    // Defense in depth: canonicalize the target via realpath() so symlinks in
    // any segment are resolved, then compare against the canonical root. This
    // prevents a symlinked plugin dir (whether malicious or accidental) from
    // letting rm -rf escape the Cursor plugins tree.
    let canonicalRoot: string;
    let canonicalTarget: string;
    try {
      canonicalRoot = await realpath(root);
    } catch (err) {
      return { agent: "cursor", target: name, status: "failed", message: `cannot resolve cursor root: ${(err as Error).message}` };
    }
    try {
      canonicalTarget = await realpath(path);
    } catch (err) {
      return { agent: "cursor", target: path, status: "failed", message: `cannot resolve plugin path: ${(err as Error).message}` };
    }
    if (canonicalTarget === canonicalRoot) {
      return { agent: "cursor", target: path, status: "failed", message: "refusing to delete the plugins root" };
    }
    if (!canonicalTarget.startsWith(`${canonicalRoot}/`)) {
      return {
        agent: "cursor",
        target: path,
        status: "failed",
        message: `refusing to delete path that resolves outside ${canonicalRoot}: ${canonicalTarget}`,
      };
    }
    // Belt-and-braces: also reject if the immediate target is itself a symlink,
    // even if realpath stays inside root (e.g. a symlink to a sibling inside root —
    // the user's intent is to delete the plugin dir, not redirect through a link).
    try {
      const lstatInfo = await stat(path);
      if (!lstatInfo.isDirectory()) {
        return { agent: "cursor", target: path, status: "failed", message: "plugin path is not a directory" };
      }
    } catch (err) {
      return { agent: "cursor", target: path, status: "failed", message: (err as Error).message };
    }
    if (opts.dryRun) return { agent: "cursor", target: path, status: "removed", message: "dry-run" };
    try {
      await rm(path, { recursive: true, force: true });
      return { agent: "cursor", target: path, status: "removed" };
    } catch (err) {
      return { agent: "cursor", target: path, status: "failed", message: (err as Error).message };
    }
  },
};
