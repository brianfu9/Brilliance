import { describe, expect, it } from "vitest"
import { contentText, messagesOf, splitReasoning } from "./CaptureDialog"

describe("CaptureDialog helpers", () => {
  it("splits a Qwen reasoning block from the answer", () => {
    expect(splitReasoning("<think>\nplan\n</think>\n\nanswer")).toEqual({ reasoning: "plan", answer: "answer" })
    expect(splitReasoning("plain")).toEqual({ reasoning: "", answer: "plain" })
    expect(splitReasoning("chain only</think>rest")).toEqual({ reasoning: "chain only", answer: "rest" })
  })
  it("reads string and part-array content", () => {
    expect(contentText("hi")).toBe("hi")
    expect(contentText([{ type: "text", text: "a" }, { type: "image_url" }])).toBe("a\n[image_url]")
  })
  it("lists chat messages with tool calls and tool results", () => {
    const m = messagesOf({
      messages: [
        { role: "system", content: "sys" },
        { role: "assistant", content: "", tool_calls: [{ function: { name: "read", arguments: "{\"p\":1}" } }] },
        { role: "tool", tool_call_id: "c1", content: "out" },
      ],
    })
    expect(m.map((x) => x.role)).toEqual(["system", "assistant", "tool (c1)"])
    expect(m[1].extra).toContain("read({\"p\":1})")
  })
  it("lists an Anthropic system prompt first", () => {
    expect(messagesOf({ system: "s", messages: [{ role: "user", content: "u" }] }).map((x) => x.role)).toEqual(["system", "user"])
  })
})
