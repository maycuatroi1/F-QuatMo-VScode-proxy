import { expect, test } from "bun:test";
import { parseXmlToolCall, XmlToolCallConverter } from "../src/routes/chat";

test("XML tool contract preserves arguments as strings and rejects ordinary text", () => {
  expect(parseXmlToolCall("ordinary explanation")).toBeNull();
  expect(parseXmlToolCall('<function=write_file><parameter=path> src/main.py </parameter><parameter=content>print("hello")\n</parameter></function>'))
    .toEqual({ name: "write_file", arguments: { path: "src/main.py", content: 'print("hello")' } });
});

test("XML streaming converter retains partial tags, surrounding text and trailing flush", () => {
  const converter = new XmlToolCallConverter();
  const output = [
    ...converter.processChunk("Before <func"),
    ...converter.processChunk('tion=read_file><parameter=path>main.py</parameter></func'),
    ...converter.processChunk("tion> after"),
    ...converter.flush(),
  ];
  expect(output.filter((chunk) => chunk.delta.content).map((chunk) => chunk.delta.content).join("")).toBe("Before  after");
  const tool = output.flatMap((chunk) => chunk.delta.tool_calls || []);
  expect(tool).toHaveLength(1);
  expect(tool[0].function).toEqual({ name: "read_file", arguments: '{"path":"main.py"}' });
  const partial = new XmlToolCallConverter();
  const chunks = [...partial.processChunk("<function=unfinished>"), ...partial.flush()];
  expect(chunks.map((chunk) => chunk.delta.content || "").join("")).toBe("<function=unfinished>");
});
