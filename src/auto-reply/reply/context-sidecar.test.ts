import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { estimateMessagesTokens } from "../../agents/compaction.js";
import { withEnv } from "../../test-utils/env.js";
import type { TemplateContext } from "../templating.js";
import {
  buildInboundContextSidecar,
  projectHistoricalMessagesWithContextSidecarBudget,
  serializeLegacyInboundContextPrefix,
} from "./context-sidecar.js";
import { buildInboundUserContextPrefix } from "./inbound-meta.js";

function parseLegacyBlocks(text: string): Array<{ title: string; payload: unknown }> {
  const blockRe = /(^[^\n]+):\n```json\n([\s\S]*?)\n```/gm;
  const blocks: Array<{ title: string; payload: unknown }> = [];
  for (const match of text.matchAll(blockRe)) {
    const title = match[1];
    const payload = match[2];
    if (!title || !payload) {
      continue;
    }
    blocks.push({ title: `${title}:`, payload: JSON.parse(payload) });
  }
  return blocks;
}

function messageText(message: { content?: unknown } | undefined): string {
  const content = message?.content;
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

describe("buildInboundContextSidecar", () => {
  it("extracts structured inbound context without mutating body semantics", () => {
    const sidecar = buildInboundContextSidecar({
      ChatType: "group",
      MessageSid: " msg-123 ",
      ReplyToId: " msg-122 ",
      SenderId: " 289522496 ",
      SenderName: " Tyler ",
      Timestamp: Date.UTC(2026, 1, 15, 13, 35),
      GroupSubject: " Ops Room ",
      ThreadLabel: " Incident Thread ",
      MessageThreadId: 42,
      WasMentioned: true,
      ReplyToBody: "quoted body",
      ReplyToSender: "Alice",
      ReplyToIsQuote: true,
      ForwardedFrom: "relay-bot",
      ForwardedFromType: "bot",
      ThreadStarterBody: "starter body",
      InboundHistory: [{ sender: "Bob", body: "hello", timestamp: 1 }],
    } as TemplateContext);

    expect(sidecar).toEqual({
      formatVersion: 1,
      conversation: {
        messageId: "msg-123",
        replyToId: "msg-122",
        senderId: "289522496",
        sender: "Tyler",
        timestamp: expect.any(String),
        groupSubject: "Ops Room",
        threadLabel: "Incident Thread",
        topicId: "42",
        isGroupChat: true,
        wasMentioned: true,
        hasReplyContext: true,
        hasForwardedContext: true,
        hasThreadStarter: true,
        historyCount: 1,
      },
      sender: {
        label: "Tyler (289522496)",
        id: "289522496",
        name: "Tyler",
        username: undefined,
        tag: undefined,
        e164: undefined,
      },
      thread: {
        starterBody: "starter body",
      },
      reply: {
        senderLabel: "Alice",
        isQuote: true,
        body: "quoted body",
      },
      forwarded: {
        from: "relay-bot",
        type: "bot",
      },
      history: [{ sender: "Bob", timestampMs: 1, body: "hello" }],
    });
  });

  it("supports envelope-aware timestamps and legacy-compatible serialization", () => {
    withEnv({ TZ: "America/Los_Angeles" }, () => {
      const ctx = {
        ChatType: "group",
        MessageSid: "msg-with-user-tz",
        Timestamp: Date.UTC(2026, 2, 19, 0, 0),
        SenderName: "Tyler",
        SenderId: "+15551234567",
      } as TemplateContext;

      const sidecar = buildInboundContextSidecar(ctx, {
        timezone: "user",
        userTimezone: "Asia/Tokyo",
      });

      expect(sidecar.conversation).toMatchObject({
        timestamp: "Thu 2026-03-19 09:00 GMT+9",
      });

      expect(serializeLegacyInboundContextPrefix(sidecar)).toBe(
        buildInboundUserContextPrefix(ctx, {
          timezone: "user",
          userTimezone: "Asia/Tokyo",
        }),
      );
    });
  });

  it("rebuilds the historic metadata prefix from structured sidecar fields", () => {
    const serialized = serializeLegacyInboundContextPrefix({
      formatVersion: 1,
      sender: { label: "Tyler (+15551234567)", id: "+15551234567", name: "Tyler" },
      reply: { senderLabel: "Bob", body: "quoted body" },
      history: [{ sender: "Bob", timestampMs: 1, body: "hello" }],
    });
    const blocks = parseLegacyBlocks(serialized);

    expect(blocks.map((block) => block.title)).toEqual([
      "Sender (untrusted metadata):",
      "Replied message (untrusted, for context):",
      "Chat history since last reply (untrusted, for context):",
    ]);
    expect(blocks[0]?.payload).toMatchObject({
      label: "Tyler (+15551234567)",
      id: "+15551234567",
      name: "Tyler",
    });
    expect(blocks[1]?.payload).toMatchObject({
      sender_label: "Bob",
      body: "quoted body",
    });
    expect(blocks[2]?.payload).toEqual([{ sender: "Bob", timestamp_ms: 1, body: "hello" }]);
  });

  it("omits direct webchat conversation metadata like the legacy prefix", () => {
    const ctx = {
      ChatType: "direct",
      OriginatingChannel: "webchat",
      MessageSid: "short-id",
      MessageSidFull: "provider-full-id",
    } as TemplateContext;

    const sidecar = buildInboundContextSidecar(ctx);
    expect(sidecar).toEqual({ formatVersion: 1 });
    expect(serializeLegacyInboundContextPrefix(sidecar)).toBe("");
    expect(serializeLegacyInboundContextPrefix(sidecar)).toBe(buildInboundUserContextPrefix(ctx));
  });

  it("lightens older sidecar-backed turns before dropping the latest turn's context", () => {
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
      },
      {
        role: "assistant",
        content: "older answer",
        timestamp: 2,
      },
      {
        role: "user",
        content: "latest ask",
        contextSidecar: {
          formatVersion: 1,
          history: repeatedHistory,
          conversation: { historyCount: repeatedHistory.length },
        },
        timestamp: 3,
      },
    ];

    const fullProjection = projectHistoricalMessagesWithContextSidecarBudget(
      messages as AgentMessage[],
    );
    const projected = projectHistoricalMessagesWithContextSidecarBudget(
      messages as AgentMessage[],
      estimateMessagesTokens(fullProjection) - 200,
    );

    expect(messageText(projected[0])).not.toContain("Chat history since last reply");
    expect(messageText(projected[2])).toContain("Chat history since last reply");
  });

  it("keeps duplicated thread starter context on only the most recent older sidecar turn", () => {
    const repeatedThreadStarter = `starter ${"x".repeat(4_000)}`;
    const messages = [
      {
        role: "user",
        content: "older ask 1",
        contextSidecar: {
          formatVersion: 1,
          thread: {
            starterBody: repeatedThreadStarter,
          },
          conversation: {
            hasThreadStarter: true,
          },
        },
        timestamp: 1,
      },
      {
        role: "assistant",
        content: "older answer 1",
        timestamp: 2,
      },
      {
        role: "user",
        content: "older ask 2",
        contextSidecar: {
          formatVersion: 1,
          thread: {
            starterBody: repeatedThreadStarter,
          },
          conversation: {
            hasThreadStarter: true,
          },
        },
        timestamp: 3,
      },
      {
        role: "assistant",
        content: "older answer 2",
        timestamp: 4,
      },
      {
        role: "user",
        content: "latest ask",
        contextSidecar: {
          formatVersion: 1,
          thread: {
            starterBody: repeatedThreadStarter,
          },
          conversation: {
            hasThreadStarter: true,
          },
        },
        timestamp: 5,
      },
    ];

    const fullProjection = projectHistoricalMessagesWithContextSidecarBudget(
      messages as AgentMessage[],
    );
    const projected = projectHistoricalMessagesWithContextSidecarBudget(
      messages as AgentMessage[],
      estimateMessagesTokens(fullProjection) - 200,
    );

    expect(messageText(projected[0])).not.toContain("Thread starter (untrusted, for context)");
    expect(messageText(projected[2])).toContain("Thread starter (untrusted, for context)");
  });
});
