import React from "react";
import { Box, Text, render } from "ink";
import BigText from "ink-big-text";
import Gradient from "ink-gradient";

import packageJson from "../package.json" with { type: "json" };

const VERSION = packageJson.version;

interface CommandRow {
  cmd: string;
  desc: string;
}

const COMMANDS: CommandRow[] = [
  { cmd: "syncthis sync", desc: "MCP union + skills (all agents)" },
  { cmd: "syncthis status", desc: "plugin × agent matrix — find silent failures" },
  { cmd: "syncthis mirror <primary>", desc: "destructive plugin push from primary → all" },
  { cmd: "syncthis mcp / skills", desc: "MCP-only or skills-only sync" },
  { cmd: "syncthis <from> <to>", desc: "one-way MCP mirror between two agents" },
  { cmd: "syncthis rm <server> --all", desc: "remove one MCP server everywhere" },
  { cmd: "syncthis doctor", desc: "coverage + conflict report" },
  { cmd: "syncthis help", desc: "full help text" },
];

function Welcome() {
  const cmdWidth = Math.max(...COMMANDS.map((c) => c.cmd.length)) + 2;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Gradient colors={["#7afb95", "#00d4ff"]}>
        <BigText text="syncthis" font="block" />
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
