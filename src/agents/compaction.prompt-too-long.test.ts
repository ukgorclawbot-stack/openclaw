import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

const piCodingAgentMocks = vi.hoisted(() => ({
  generateSummary: vi.fn(),
  estimateTokens: vi.fn((_message: unknown) => 1),
}));

vi.mock("@mariozechner/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-coding-agent")>(
    "@mariozechner/pi-coding-agent",
  );
  return {
    ...actual,
    generateSummary: piCodingAgentMocks.generateSummary,
    estimateTokens: piCodingAgentMocks.estimateTokens,
  };
});

let summarizeWithFallback: typeof import("./compaction.js").summarizeWithFallback;

async function loadFreshCompactionModuleForTest() {
  vi.resetModules();
  ({ summarizeWithFallback } = await import("./compaction.js"));
}

function makeAssistantToolCall(timestamp: number, toolCallId: string): AssistantMessage {
  return makeAgentAssistantMessage({
    content: [{ type: "toolCall", id: toolCallId, name: "browser", arguments: { action: "tabs" } }],
    model: "gpt-5.2",
    stopReason: "toolUse",
    timestamp,
  });
}

function makeToolResult(timestamp: number, toolCallId: string, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "browser",
    isError: false,
    content: [{ type: "text", text }],
    timestamp,
  };
}

describe("compaction prompt-too-long retry", () => {
  beforeEach(async () => {
    await loadFreshCompactionModuleForTest();
    piCodingAgentMocks.generateSummary.mockReset();
    piCodingAgentMocks.estimateTokens.mockReset();
    piCodingAgentMocks.estimateTokens.mockImplementation((_message: unknown) => 1);
  });

  it("drops the oldest assistant round and retries summarization on context overflow", async () => {
    const messages: AgentMessage[] = [
      makeAssistantToolCall(1, "call_old"),
      makeToolResult(2, "call_old", "older result"),
      {
        role: "user",
        content: "older follow-up",
        timestamp: 3,
      } satisfies UserMessage,
      makeAssistantToolCall(4, "call_latest"),
      makeToolResult(5, "call_latest", "latest result"),
      {
        role: "user",
        content: "latest ask",
        timestamp: 6,
      } satisfies UserMessage,
    ];

    piCodingAgentMocks.generateSummary
      .mockRejectedValueOnce(new Error("prompt is too long: 277403 tokens > 200000 maximum"))
      .mockResolvedValueOnce("summary after retry");

    const summary = await summarizeWithFallback({
      messages,
      model: { id: "mock", name: "mock", contextWindow: 10000, maxTokens: 1000 } as never,
      apiKey: "test", // pragma: allowlist secret
      signal: new AbortController().signal,
      reserveTokens: 100,
      maxChunkTokens: 5000,
      contextWindow: 10000,
    });

    expect(summary).toBe("summary after retry");
    expect(piCodingAgentMocks.generateSummary).toHaveBeenCalledTimes(2);

    const calls = piCodingAgentMocks.generateSummary.mock.calls as Array<[AgentMessage[]]>;
    expect(calls[0]?.[0].map((message) => message.timestamp)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(calls[1]?.[0].map((message) => message.timestamp)).toEqual([4, 5, 6]);
  });
});
