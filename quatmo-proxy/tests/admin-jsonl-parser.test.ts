import { expect, test } from "bun:test";
import { appendJsonLines } from "../src/routes/admin";

test("appendJsonLines keeps valid records around malformed JSONL lines", () => {
  const records: Array<{ id: number }> = [];

  appendJsonLines('{"id":1}\nnot-json\n\n{"id":2}\n', records);

  expect(records).toEqual([{ id: 1 }, { id: 2 }]);
});
