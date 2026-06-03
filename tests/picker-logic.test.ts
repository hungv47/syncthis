import { describe, expect, test } from "bun:test";
import {
  buildRows,
  groupItemValues,
  groupPluginsByMarketplace,
  isAllSelected,
  isGroupSelected,
  itemValues,
  nextSelectionForRow,
  type PickerItem,
} from "../src/picker-logic.ts";

const items: PickerItem[] = [
  { value: "a", label: "a", group: "mkt1" },
  { value: "b", label: "b", group: "mkt1" },
  { value: "c", label: "c", group: "mkt2" },
];

describe("buildRows", () => {
  test("flat list: a single 'all' control then the items", () => {
    const rows = buildRows(items);
    expect(rows[0]).toEqual({ kind: "all", label: "select all (3)" });
    expect(rows.slice(1).map((r) => r.kind)).toEqual(["item", "item", "item"]);
    expect(itemValues(rows)).toEqual(["a", "b", "c"]);
  });

  test("grouped: 'all' control, then a group control before each marketplace's items", () => {
    const rows = buildRows(items, { grouped: true });
    expect(rows[0]!.kind).toBe("all");
    expect(rows[1]).toEqual({ kind: "group", group: "mkt1", label: "mkt1 (2)" });
    expect(rows[2]!.kind).toBe("item");
    expect(rows[3]!.kind).toBe("item");
    expect(rows[4]).toEqual({ kind: "group", group: "mkt2", label: "mkt2 (1)" });
    expect(groupItemValues(rows, "mkt1")).toEqual(["a", "b"]);
    expect(groupItemValues(rows, "mkt2")).toEqual(["c"]);
  });

  test("no 'all' control for a single item", () => {
    const rows = buildRows([{ value: "only", label: "only" }]);
    expect(rows).toEqual([{ kind: "item", value: "only", label: "only", hint: undefined, group: undefined }]);
  });
});

describe("toggle logic", () => {
  const rows = buildRows(items, { grouped: true });

  test("the 'all' control selects everything, then clears everything", () => {
    const allIdx = rows.findIndex((r) => r.kind === "all");
    const afterSelect = nextSelectionForRow(new Set(), rows, allIdx);
    expect([...afterSelect].sort()).toEqual(["a", "b", "c"]);
    expect(isAllSelected(afterSelect, rows)).toBe(true);
    const afterClear = nextSelectionForRow(afterSelect, rows, allIdx);
    expect([...afterClear]).toEqual([]);
  });

  test("a group control toggles only that marketplace's items", () => {
    const grpIdx = rows.findIndex((r) => r.kind === "group" && r.group === "mkt1");
    const after = nextSelectionForRow(new Set(), rows, grpIdx);
    expect([...after].sort()).toEqual(["a", "b"]);
    expect(isGroupSelected(after, rows, "mkt1")).toBe(true);
    expect(isGroupSelected(after, rows, "mkt2")).toBe(false);
    expect(isAllSelected(after, rows)).toBe(false);
  });

  test("an item control flips just that item and never mutates the input set", () => {
    const itemIdx = rows.findIndex((r) => r.kind === "item" && r.value === "c");
    const input = new Set<string>(["a"]);
    const after = nextSelectionForRow(input, rows, itemIdx);
    expect([...after].sort()).toEqual(["a", "c"]);
    expect([...input]).toEqual(["a"]); // input untouched
    const back = nextSelectionForRow(after, rows, itemIdx);
    expect([...back]).toEqual(["a"]);
  });

  test("selecting both group items makes 'all' report selected", () => {
    let sel = new Set<string>();
    sel = nextSelectionForRow(sel, rows, rows.findIndex((r) => r.kind === "group" && r.group === "mkt1"));
    sel = nextSelectionForRow(sel, rows, rows.findIndex((r) => r.kind === "group" && r.group === "mkt2"));
    expect(isAllSelected(sel, rows)).toBe(true);
  });
});

describe("groupPluginsByMarketplace", () => {
  test("groups by marketplace, dedupes (name, marketplace), marks not-installed", () => {
    const out = groupPluginsByMarketplace([
      { name: "vercel", marketplace: "openai-plugins" },
      { name: "vercel", marketplace: "openai-plugins" }, // dup
      { name: "impeccable", marketplace: "impeccable" },
      { name: "future", marketplace: "openai-plugins", installed: false },
    ]);
    expect(out).toEqual([
      { value: "vercel", label: "vercel", group: "openai-plugins", hint: undefined },
      { value: "impeccable", label: "impeccable", group: "impeccable", hint: undefined },
      { value: "future", label: "future", group: "openai-plugins", hint: "not installed" },
    ]);
  });
});
