#!/usr/bin/env node
// Thin shim: npm needs a recognized extension for `bin` entries, so this .mjs
// stub launches the actual Bun-based TypeScript entry (bin/syncthis.ts).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "syncthis.ts");
const bun = process.env.SYNCTHIS_BUN || "bun";

const child = spawn(bun, [entry, ...process.argv.slice(2)], { stdio: "inherit" });

child.on("error", (err) => {
  if (err && err.code === "ENOENT") {
    console.error("syncthis: requires `bun` on PATH (https://bun.sh/install).");
    process.exit(127);
  }
  console.error("syncthis: failed to spawn bun:", err.message);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
