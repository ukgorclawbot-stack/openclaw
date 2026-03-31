import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { estimateMessagesTokens } from "../agents/compaction.js";
import { LegacyContextEngine } from "./legacy.js";

function messageText(message: AgentMessage | undefined): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) =>
      part && typeof part === "object" && "text" in part && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("\n");
}

describe("LegacyContextEngine", () => {
  it("projects persisted context sidecars back into legacy user prefixes", async () => {
    const engine = new LegacyContextEngine();
    const result = await engine.assemble({
      sessionId: "session-1",
      messages: [
        {
          role: "user",
          content: "tell me about cats",
          contextSidecar: {
            formatVersion: 1,
            reply: {
              senderLabel: "Bob",
              body: "quoted body",
            },
          },
          timestamp: 1,
        } as AgentMessage,
      ],
    });

    expect(result.messages[0]).toMatchObject({
      role: "user",
      content: expect.stringContaining("Replied message (untrusted, for context):"),
    });
    expect(result.messages[0]).toMatchObject({
      content: expect.stringContaining("tell me about cats"),
    });
  });

  it("preserves media blocks when projecting sidecar-backed user messages", async () => {
    const engine = new LegacyContextEngine();
    const result = await engine.assemble({
      sessionId: "session-2",
      messages: [
        {
          role: "user",
          content: [{ type: "image", data: "abc", mimeType: "image/png" }],
          contextSidecar: {
            formatVersion: 1,
            conversation: {
              hasReplyContext: true,
            },
          },
          timestamp: 1,
        } as AgentMessage,
      ],
    });

    expect(result.messages[0]).toMatchObject({
      role: "user",
      content: [
        {
          type: "text",
          text: expect.stringContaining("Conversation info (untrusted metadata):"),
        },
        {
          type: "image",
          data: "abc",
          mimeType: "image/png",
        },
      ],
    });
  });

  it("keeps messages unchanged when no sidecar is present", async () => {
    const engine = new LegacyContextEngine();
    const message = {
      role: "user",
      content: "plain text",
      timestamp: 1,
    } as AgentMessage;
    const messages = [message];

    const result = await engine.assemble({
      sessionId: "session-3",
      messages,
    });

    expect(result.messages).toBe(messages);
    expect(result.messages[0]).toBe(message);
  });

  it("drops history blocks from older sidecar-backed turns before touching the latest turn", async () => {
    const engine = new LegacyContextEngine();
    const repeatedHistory = Array.from({ length: 4 }, (_, index) => ({
      sender: "Bob",
      timestampMs: index + 1,
      body: `older context ${index} ${"x".repeat(800)}`,
    }));
    const messages = [
      {
        role: "user",
        content: "older ask",
        contextSidecar: {
          formatVersion: 1,
          history: repeatedHistory,
          conversation: { historyCount: repeatedHistory.length },
        },
        timestamp: 1,
      } as AgentMessage,
      {
        role: "assistant",
        content: "older answer",
        timestamp: 2,
      } as AgentMessage,
      {
        role: "user",
        content: "latest ask",
        contextSidecar: {
          formatVersion: 1,
          history: repeatedHistory,
          conversation: { historyCount: repeatedHistory.length },
        },
        timestamp: 3,
      } as AgentMessage,
    ];

    const full = await engine.assemble({
      sessionId: "session-4",
      messages,
    });
    const result = await engine.assemble({
      sessionId: "session-4",
      messages,
      tokenBudget: estimateMessagesTokens(full.messages) - 200,
    });

    expect(messageText(result.messages[0])).not.toContain("Chat history since last reply");
    expect(messageText(result.messages[2])).toContain("Chat history since last reply");
  });

  it("falls back to clean content for oldest sidecar-backed turns under extremely low budget", async () => {
    const engine = new LegacyContextEngine();
    const messages = [
      {
        role: "user",
        content: "older ask",
        contextSidecar: {
          formatVersion: 1,
          conversation: { historyCount: 1, hasReplyContext: true },
          reply: { senderLabel: "Bob", body: "quoted body" },
          history: [{ sender: "Bob", timestampMs: 1, body: "hello".repeat(400) }],
        },
        timestamp: 1,
      } as AgentMessage,
      {
        role: "assistant",
        content: "older answer",
        timestamp: 2,
      } as AgentMessage,
      {
        role: "user",
        content: "latest ask",
        contextSidecar: {
          formatVersion: 1,
          conversation: { historyCount: 1, hasReplyContext: true },
          reply: { senderLabel: "Bob", body: "quoted body" },
          history: [{ sender: "Bob", timestampMs: 1, body: "hello".repeat(400) }],
        },
        timestamp: 3,
      } as AgentMessage,
    ];

    const result = await engine.assemble({
      sessionId: "session-5",
      messages,
      tokenBudget: 1,
    });

    expect(messageText(result.messages[0])).toBe("older ask");
    expect(messageText(result.messages[2])).toContain("Replied message (untrusted, for context):");
  });
});
