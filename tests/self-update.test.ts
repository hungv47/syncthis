import { describe, expect, test } from "bun:test";
import { deriveGlobalPrefix } from "../src/self-update.ts";

describe("deriveGlobalPrefix", () => {
  test("unix: Homebrew node prefix (the shadow-install bug)", () => {
    // The exact case that froze the banner at a stale version: PATH ran the Homebrew
    // copy while `npm -g` pointed elsewhere. update must target THIS prefix.
    expect(deriveGlobalPrefix("/opt/homebrew/lib/node_modules/@hungv47/syncthis", "/")).toBe("/opt/homebrew");
  });

  test("unix: version-manager prefix", () => {
    expect(deriveGlobalPrefix("/Users/x/.hermes/node/lib/node_modules/@hungv47/syncthis", "/")).toBe(
      "/Users/x/.hermes/node",
    );
  });

  test("unix: non-scoped package", () => {
    expect(deriveGlobalPrefix("/usr/local/lib/node_modules/syncthis", "/")).toBe("/usr/local");
  });

  test("windows: no lib segment", () => {
    expect(deriveGlobalPrefix("C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@hungv47\\syncthis", "\\")).toBe(
      "C:\\Users\\x\\AppData\\Roaming\\npm",
    );
  });

  test("dev / source run (not inside node_modules) → empty, use npm default", () => {
    expect(deriveGlobalPrefix("/Users/x/dev/syncthis", "/")).toBe("");
  });

  test("the last node_modules wins (nested installs)", () => {
    expect(deriveGlobalPrefix("/a/lib/node_modules/x/node_modules/@hungv47/syncthis", "/")).toBe(
      "/a/lib/node_modules/x",
    );
  });
});
