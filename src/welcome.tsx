import React from "react";
import { Box, Text, render } from "ink";
import Gradient from "ink-gradient";

import packageJson from "../package.json" with { type: "json" };

const VERSION = packageJson.version;

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

const COMMANDS: CommandRow[] = [
  { cmd: "syncthis sync", desc: "MCP union + skills (all agents)" },
  { cmd: "syncthis mcp / skills", desc: "MCP-only or skills-only sync" },
  { cmd: "syncthis <from> <to>", desc: "one-way MCP mirror between two agents" },
  { cmd: "syncthis rm <server> --all", desc: "remove one MCP server everywhere" },
  { cmd: "syncthis mirror <primary>", desc: "mirror one agent's plugins to every other agent (additive)" },
  { cmd: "syncthis plugin list", desc: "list installed plugins per agent" },
  { cmd: "syncthis doctor", desc: "MCP coverage + conflict report" },
  { cmd: "syncthis help", desc: "full help text" },
];

function Welcome() {
  const cmdWidth = Math.max(...COMMANDS.map((c) => c.cmd.length)) + 2;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Gradient colors={["#7afb95", "#00d4ff"]}>
        <Text>{WORDMARK}</Text>
      </Gradient>

      <Box marginBottom={1} marginLeft={2}>
        <Text dimColor>Keep your AI coding agents in sync — MCP servers + skills.</Text>
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
