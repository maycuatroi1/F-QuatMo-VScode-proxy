import { expect, test } from "bun:test";
import { appendJsonLines, countNonEmptyLines, hasNonEmptyLine } from "../src/modules/telemetry/jsonl";

test("JSONL preserves ordering, duplicates, primitives and an existing target", () => {
  const target: any[] = [{ existing: true }];
  appendJsonLines('\uFEFF{"id":1}\r\ninvalid\r\n{"id":1}\nnull\n0\nfalse\n[2,3]', target);
  expect(target).toEqual([{ existing: true }, { id: 1 }, { id: 1 }, null, 0, false, [2, 3]]);
});

test("JSONL counts physical non-empty lines, including malformed evidence", () => {
  expect(countNonEmptyLines(' \r\n{"id":1}\r\n invalid \n\t\n{"id":2}')).toBe(3);
  expect(countNonEmptyLines("\n\r\n\t")).toBe(0);
  expect(hasNonEmptyLine("\n\r\n\t")).toBe(false);
  expect(hasNonEmptyLine(" invalid ")).toBe(true);
  expect(hasNonEmptyLine("\uFEFF")).toBe(true);
  expect(countNonEmptyLines("\uFEFF")).toBe(0);
});

test("large JSONL import retains every valid record around corrupt lines", () => {
  const expected = Array.from({ length: 10000 }, (_, id) => ({ id }));
  const content = expected.map((value) => JSON.stringify(value)).join("\nmalformed\n");
  const actual: any[] = [];
  appendJsonLines(content, actual);
  expect(actual).toEqual(expected);
  expect(countNonEmptyLines(content)).toBe(19999);
});
