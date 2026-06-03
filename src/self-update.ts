// Self-update prefix resolution.
//
// `syncthis update` must refresh the copy that is actually on your PATH. A plain
// `npm install -g` installs into npm's *default* global prefix, which on a machine
// with more than one Node prefix (e.g. a Homebrew node on PATH while `npm -g`
// points at a version-manager prefix) is NOT where the running binary lives — so
// the update lands in a copy you never run and the version stays stale every
// release. The fix is to pin npm to the prefix that owns the running bundle via
// `--prefix`, derived here from that bundle's on-disk location.

import { sep as osSep } from "node:path";

// Given the on-disk package root of a global install — `<prefix>/lib/node_modules/
// @scope/pkg` on unix, `<prefix>/node_modules/@scope/pkg` on Windows — return the
// global PREFIX npm associates with it, so `npm install -g --prefix <p>` updates
// exactly this copy. Returns "" when the path isn't inside a node_modules (a dev or
// source run), signalling "fall back to npm's default global".
export function deriveGlobalPrefix(packageRoot: string, sep: string = osSep): string {
  const parts = packageRoot.split(sep);
  const nm = parts.lastIndexOf("node_modules");
  if (nm <= 0) return "";
  // unix nests globals under `<prefix>/lib/node_modules`; Windows uses
  // `<prefix>/node_modules` directly. Drop the `lib` segment only when present.
  const end = parts[nm - 1] === "lib" ? nm - 1 : nm;
  return parts.slice(0, end).join(sep);
}
