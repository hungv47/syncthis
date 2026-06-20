// Auto-detect what `syncthis add <source>` should treat a token as, so the user
// doesn't have to name the type. Pure + zero-network: the type is inferred from the
// token shape plus, for a bare name, whether Claude already has a plugin by that name.
//
//   owner/repo  → skill   (skills are distributed as repos; `add skill` is repo-based)
//   bare name   → plugin  if claude-code already has an installed plugin by that name
//                          (syncthis propagates it — name-based, like `add plugin`)
//               → mcp     otherwise (a bare name syncthis can't place is an MCP server
//                          name, and syncthis mirrors MCP servers — it never installs them)
//
// `--as <type>` overrides detection entirely. This deliberately does NOT install a
// plugin from a raw repo: syncthis propagates plugins already installed on Claude
// (name-based), it is not a from-repo plugin installer — consistent with the founding
// "sync layer, not an installer" principle.

export type AddType = "skill" | "plugin" | "mcp";

export type DetectOpts = {
  // Explicit `--as` override; when set, detection is skipped.
  as?: string;
  // Names of plugins installed on claude-code (the source). Used only to classify a
  // bare name as a known plugin vs. an MCP server name.
  installedPluginNames?: ReadonlySet<string>;
};

export function isAddType(v: string): v is AddType {
  return v === "skill" || v === "plugin" || v === "mcp";
}

// Does classifying this token require Claude's installed-plugin list? Only a bare name
// (no slash) without an explicit `--as` does — a slash is unambiguously a skill repo.
export function needsInstalledPlugins(token: string, as?: string): boolean {
  return !as && !token.includes("/");
}

export function detectAddType(token: string, opts: DetectOpts = {}): AddType {
  if (opts.as !== undefined) {
    if (!isAddType(opts.as)) {
      throw new Error(`--as must be one of skill, plugin, mcp (got \`${opts.as}\`)`);
    }
    return opts.as;
  }
  // An owner/repo slug is a skill repo. Plugins are propagated by installed name, not
  // added from a repo, so a slash never means "plugin" under auto-detect.
  if (token.includes("/")) return "skill";
  // Bare name: a plugin claude-code already has → propagate it; otherwise the only thing
  // a lone name can be is an MCP server, which syncthis does not install.
  if (opts.installedPluginNames?.has(token)) return "plugin";
  return "mcp";
}
