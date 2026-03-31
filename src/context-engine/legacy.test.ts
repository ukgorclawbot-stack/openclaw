import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { estimateMessagesTokens } from "../agents/compaction.js";
import { serializeLegacyInboundContextPrefix } from "../auto-reply/reply/context-sidecar.js";
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

    expect(result.systemPromptAddition).toBe(
      serializeLegacyInboundContextPrefix({
        formatVersion: 1,
        reply: {
          senderLabel: "Bob",
          body: "quoted body",
        },
      }),
    );
    expect(result.messages[0]).toMatchObject({
      role: "user",
      content: "tell me about cats",
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

    expect(result.systemPromptAddition).toBe(
      serializeLegacyInboundContextPrefix({
        formatVersion: 1,
        conversation: {
          hasReplyContext: true,
        },
      }),
    );
    expect(result.messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "image", data: "abc", mimeType: "image/png" }],
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

  it("keeps older sidecar-backed turns inline while moving the latest turn into systemPromptAddition", async () => {
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

    const result = await engine.assemble({
      sessionId: "session-4",
      messages,
    });

    expect(messageText(result.messages[0])).toContain(
      "Chat history since last reply (untrusted, for context):",
    );
    expect(messageText(result.messages[2])).toBe("latest ask");
    expect(result.systemPromptAddition).toContain(
      "Chat history since last reply (untrusted, for context):",
    );
  });

  it("moves the latest sidecar prefix into systemPromptAddition and keeps the latest user body clean", async () => {
    const engine = new LegacyContextEngine();
    const olderSidecar = {
      formatVersion: 1,
      reply: {
        senderLabel: "Bob",
        body: "older quoted body",
      },
    } as const;
    const latestSidecar = {
      formatVersion: 1,
      reply: {
        senderLabel: "Alice",
        body: "latest quoted body",
      },
      history: [
        {
          sender: "Alice",
          timestampMs: 2,
          body: "latest history",
        },
      ],
    } as const;
    const latestContent = [
      { type: "text", text: "latest ask" },
      { type: "image", data: "abc", mimeType: "image/png" },
    ] as const;
    const messages = [
      {
        role: "user",
        content: "older ask",
        contextSidecar: olderSidecar,
        timestamp: 1,
      } as AgentMessage,
      {
        role: "assistant",
        content: "older answer",
        timestamp: 2,
      } as AgentMessage,
      {
        role: "user",
        content: latestContent,
        contextSidecar: latestSidecar,
        timestamp: 3,
      } as AgentMessage,
    ];

    const result = await engine.assemble({
      sessionId: "session-6",
      messages,
    });

    expect(result.systemPromptAddition).toBe(
      serializeLegacyInboundContextPrefix(latestSidecar),
    );
    expect(messageText(result.messages[0])).toContain("Replied message (untrusted, for context):");
    expect(result.messages[2]).toMatchObject({
      role: "user",
      content: latestContent,
    });
    expect(messageText(result.messages[2]).trim()).toBe("latest ask");
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

    const full = await engine.assemble({
      sessionId: "session-5",
      messages,
    });
    const fullTokenCount =
      estimateMessagesTokens(full.messages) +
      estimateMessagesTokens([
        { role: "system", content: full.systemPromptAddition ?? "" } as AgentMessage,
      ]);

    const result = await engine.assemble({
      sessionId: "session-5",
      messages,
      tokenBudget: Math.max(1, fullTokenCount - 200),
    });

    expect(messageText(result.messages[0])).toBe("older ask");
    expect(messageText(result.messages[2])).toBe("latest ask");
    expect(result.systemPromptAddition).toContain("Replied message (untrusted, for context):");
  });
});
