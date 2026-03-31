import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  estimateMessagesTokens,
  pruneHistoryForContextShare,
  splitMessagesByTokenShare,
} from "./compaction.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

function makeMessage(id: number, size: number): AgentMessage {
  return {
    role: "user",
    content: "x".repeat(size),
    timestamp: id,
  };
}

function makeMessages(count: number, size: number): AgentMessage[] {
  return Array.from({ length: count }, (_, index) => makeMessage(index + 1, size));
}

function makeAssistantToolCall(
  timestamp: number,
  toolCallId: string,
  text = "x".repeat(4000),
): AssistantMessage {
  return makeAgentAssistantMessage({
    content: [
      { type: "text", text },
      { type: "toolCall", id: toolCallId, name: "test_tool", arguments: {} },
    ],
    model: "gpt-5.2",
    stopReason: "stop",
    timestamp,
  });
}

function makeToolResult(timestamp: number, toolCallId: string, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "test_tool",
    content: [{ type: "text", text }],
    isError: false,
    timestamp,
  };
}

function pruneLargeSimpleHistory() {
  const messages = makeMessages(4, 4000);
  const maxContextTokens = 2000; // budget is 1000 tokens (50%)
  const pruned = pruneHistoryForContextShare({
    messages,
    maxContextTokens,
    maxHistoryShare: 0.5,
    parts: 2,
  });
  return { messages, pruned, maxContextTokens };
}

describe("splitMessagesByTokenShare", () => {
  it("splits messages into two non-empty parts", () => {
    const messages = makeMessages(4, 4000);

    const parts = splitMessagesByTokenShare(messages, 2);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts[0]?.length).toBeGreaterThan(0);
    expect(parts[1]?.length).toBeGreaterThan(0);
    expect(parts.flat().length).toBe(messages.length);
  });

  it("preserves message order across parts", () => {
    const messages = makeMessages(6, 4000);

    const parts = splitMessagesByTokenShare(messages, 3);
    expect(parts.flat().map((msg) => msg.timestamp)).toEqual(messages.map((msg) => msg.timestamp));
  });
});

describe("pruneHistoryForContextShare", () => {
  it("drops older chunks until the history budget is met", () => {
    const { pruned, maxContextTokens } = pruneLargeSimpleHistory();

    expect(pruned.droppedChunks).toBeGreaterThan(0);
    expect(pruned.keptTokens).toBeLessThanOrEqual(Math.floor(maxContextTokens * 0.5));
    expect(pruned.messages.length).toBeGreaterThan(0);
  });

  it("keeps the newest messages when pruning", () => {
    const messages = makeMessages(6, 4000);
    const totalTokens = estimateMessagesTokens(messages);
    const maxContextTokens = Math.max(1, Math.floor(totalTokens * 0.5)); // budget = 25%
    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    const keptIds = pruned.messages.map((msg) => msg.timestamp);
    const expectedSuffix = messages.slice(-keptIds.length).map((msg) => msg.timestamp);
    expect(keptIds).toEqual(expectedSuffix);
  });

  it("keeps history when already within budget", () => {
    const messages: AgentMessage[] = [makeMessage(1, 1000)];
    const maxContextTokens = 2000;
    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    expect(pruned.droppedChunks).toBe(0);
    expect(pruned.messages.length).toBe(messages.length);
    expect(pruned.keptTokens).toBe(estimateMessagesTokens(messages));
    expect(pruned.droppedMessagesList).toEqual([]);
  });

  it("returns droppedMessagesList containing dropped messages", () => {
    // Note: This test uses simple user messages with no tool calls.
    // When orphaned tool_results exist, droppedMessages may exceed
    // droppedMessagesList.length since orphans are counted but not
    // added to the list (they lack context for summarization).
    const { messages, pruned } = pruneLargeSimpleHistory();

    expect(pruned.droppedChunks).toBeGreaterThan(0);
    // Without orphaned tool_results, counts match exactly
    expect(pruned.droppedMessagesList.length).toBe(pruned.droppedMessages);

    // All messages accounted for: kept + dropped = original
    const allIds = [
      ...pruned.droppedMessagesList.map((m) => m.timestamp),
      ...pruned.messages.map((m) => m.timestamp),
    ].toSorted((a, b) => a - b);
    const originalIds = messages.map((m) => m.timestamp).toSorted((a, b) => a - b);
    expect(allIds).toEqual(originalIds);
  });

  it("returns empty droppedMessagesList when no pruning needed", () => {
    const messages: AgentMessage[] = [makeMessage(1, 100)];
    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens: 100_000,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    expect(pruned.droppedChunks).toBe(0);
    expect(pruned.droppedMessagesList).toEqual([]);
    expect(pruned.messages.length).toBe(1);
  });

  it("drops an older assistant round as a whole when pruning", () => {
    const messages: AgentMessage[] = [
      makeAssistantToolCall(1, "call_123"),
      makeToolResult(2, "call_123", "result".repeat(500)),
      {
        role: "user",
        content: "older round follow-up",
        timestamp: 3,
      },
      makeAssistantToolCall(4, "call_456", "y".repeat(500)),
      makeToolResult(5, "call_456", "result"),
      {
        role: "user",
        content: "latest ask",
        timestamp: 6,
      },
    ];

    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens: 2000,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    expect(pruned.droppedMessagesList.map((m) => m.timestamp)).toEqual([1, 2, 3]);
    expect(pruned.messages.map((m) => m.timestamp)).toEqual([4, 5, 6]);
  });

  it("keeps tool_result when its tool_use is also kept", () => {
    // Scenario: both tool_use and tool_result are in the kept portion
    const messages: AgentMessage[] = [
      // Chunk 1 (will be dropped) - just user content
      {
        role: "user",
        content: "x".repeat(4000),
        timestamp: 1,
      },
      // Chunk 2 (will be kept) - contains both tool_use and tool_result
      makeAssistantToolCall(2, "call_456", "y".repeat(500)),
      makeToolResult(3, "call_456", "result"),
    ];

    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens: 2000,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    // Both assistant and toolResult should be in kept messages
    const keptRoles = pruned.messages.map((m) => m.role);
    expect(keptRoles).toContain("assistant");
    expect(keptRoles).toContain("toolResult");
  });

  it("drops all tool results that belong to a pruned assistant round", () => {
    const messages: AgentMessage[] = [
      makeAgentAssistantMessage({
        content: [
          { type: "text", text: "x".repeat(4000) },
          { type: "toolCall", id: "call_a", name: "tool_a", arguments: {} },
          { type: "toolCall", id: "call_b", name: "tool_b", arguments: {} },
        ],
        model: "gpt-5.2",
        stopReason: "stop",
        timestamp: 1,
      }),
      makeToolResult(2, "call_a", "result_a"),
      makeToolResult(3, "call_b", "result_b"),
      {
        role: "user",
        content: "older round follow-up",
        timestamp: 4,
      },
      makeAssistantToolCall(5, "call_c", "y".repeat(500)),
      makeToolResult(6, "call_c", "result_c"),
      {
        role: "user",
        content: "latest ask",
        timestamp: 7,
      },
    ];

    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens: 2000,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    expect(pruned.droppedMessagesList.map((m) => m.timestamp)).toEqual([1, 2, 3, 4]);
    expect(pruned.messages.map((m) => m.timestamp)).toEqual([5, 6, 7]);
  });

  it("keeps the newest assistant round intact instead of splitting it across prune iterations", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "x".repeat(4_000),
        timestamp: 1,
      },
      makeAssistantToolCall(2, "call_round_keep", "y".repeat(5_000)),
      makeToolResult(3, "call_round_keep", "z".repeat(5_000)),
      {
        role: "user",
        content: "latest question",
        timestamp: 4,
      },
    ];

    const pruned = pruneHistoryForContextShare({
      messages,
      maxContextTokens: 3_000,
      maxHistoryShare: 0.5,
      parts: 2,
    });

    expect(pruned.droppedMessagesList.map((m) => m.timestamp)).toEqual([1]);
    expect(pruned.messages.map((m) => m.timestamp)).toEqual([2, 3, 4]);
    expect(pruned.messages.map((m) => m.role)).toEqual(["assistant", "toolResult", "user"]);
  });
});
