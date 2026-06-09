import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { Box, Text, render } from "ink";
import Gradient from "ink-gradient";

function readPackageVersion(): string {
  try {
    const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "../package.json");
    const raw = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
    return typeof raw.version === "string" ? raw.version : "unknown";
  } catch {
    return "unknown";
  }
}

const VERSION = readPackageVersion();

// The "syncthis" wordmark, pre-rendered in cfonts' `block` font. Embedded as a
// static string on purpose: cfonts (via ink-big-text) loads its font JSON with a
// runtime `require("../fonts/block.json")`, which `bun build` can't resolve, so the
// single-file bundle threw "Font file for the font 'block' could not be found" for
// every published (node-bundled) install. A static banner has no runtime font
// dependency — the gradient still colors it. Regenerate via cfonts if the name changes.
const WORDMARK = [
  " ███████╗ ██╗   ██╗ ███╗   ██╗  ██████╗ ████████╗ ██╗  ██╗ ██╗ ███████╗",
  " ██╔════╝ ╚██╗ ██╔╝ ████╗  ██║ ██╔════╝ ╚══██╔══╝ ██║  ██║ ██║ ██╔════╝",
  " ███████╗  ╚████╔╝  ██╔██╗ ██║ ██║         ██║    ███████║ ██║ ███████╗",
  " ╚════██║   ╚██╔╝   ██║╚██╗██║ ██║         ██║    ██╔══██║ ██║ ╚════██║",
  " ███████║    ██║    ██║ ╚████║ ╚██████╗    ██║    ██║  ██║ ██║ ███████║",
  " ╚══════╝    ╚═╝    ╚═╝  ╚═══╝  ╚═════╝    ╚═╝    ╚═╝  ╚═╝ ╚═╝ ╚══════╝",
].join("\n");

interface CommandRow {
  cmd: string;
  desc: string;
}

// Descriptions are kept short on purpose: the row is `$ ` + a fixed-width command
// column + the description, all in one Ink flex row, so a long description wraps
// (and garbles) on an 80-col terminal. Keep each desc within ~43 chars.
export const COMMANDS: CommandRow[] = [
  { cmd: "syncthis sync", desc: "share MCP + skills with every agent" },
  { cmd: "syncthis plugins add <name> --all", desc: "push plugin content to agents" },
  { cmd: "syncthis mcp sync", desc: "MCP servers only (skip skills)" },
  { cmd: "syncthis skills update", desc: "refresh skills (npx skills update)" },
  { cmd: "syncthis update", desc: "update syncthis to latest" },
  { cmd: "syncthis mcp <from> <to>", desc: "one-way MCP copy between two agents" },
  { cmd: "syncthis mcp rm <server> --all", desc: "remove one MCP server everywhere" },
  { cmd: "syncthis plugins list", desc: "list installed plugins per agent" },
  { cmd: "syncthis doctor", desc: "coverage + conflict report" },
  { cmd: "syncthis help", desc: "full command list + flags" },
];

function Welcome() {
  const cmdWidth = Math.max(...COMMANDS.map((c) => c.cmd.length)) + 2;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Gradient colors={["#7afb95", "#00d4ff"]}>
        <Text>{WORDMARK}</Text>
      </Gradient>

      <Box marginBottom={1} marginLeft={2}>
        <Text dimColor>Keep your AI coding agents in sync — MCP servers, skills &amp; plugins.</Text>
      </Box>

      {COMMANDS.map((c) => (
        <Box key={c.cmd}>
          <Text dimColor>  $ </Text>
          <Box width={cmdWidth}>
            <Text>{c.cmd}</Text>
          </Box>
          <Text dimColor>{c.desc}</Text>
        </Box>
      ))}

      <Box marginTop={1} marginLeft={2}>
        <Text>try: </Text>
        <Text color="green">syncthis sync</Text>
        <Text dimColor>  — propagate every server, everywhere</Text>
      </Box>

      <Box marginTop={1} marginLeft={2}>
        <Text dimColor>v{VERSION} · </Text>
        <Text color="cyan">https://github.com/hungv47/syncthis</Text>
      </Box>
    </Box>
  );
}

export async function renderWelcome(): Promise<void> {
  const app = render(<Welcome />);
  app.unmount();
  await app.waitUntilExit();
}
