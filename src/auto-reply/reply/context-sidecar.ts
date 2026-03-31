import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateMessagesTokens } from "../../agents/compaction.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveSenderLabel } from "../../channels/sender-label.js";
import type { EnvelopeFormatOptions } from "../envelope.js";
import { formatEnvelopeTimestamp } from "../envelope.js";
import type { TemplateContext } from "../templating.js";

export type ContextSidecar = {
  formatVersion: 1;
  conversation?: {
    messageId?: string;
    replyToId?: string;
    senderId?: string;
    conversationLabel?: string;
    sender?: string;
    timestamp?: string;
    groupSubject?: string;
    groupChannel?: string;
    groupSpace?: string;
    threadLabel?: string;
    topicId?: string;
    isForum?: boolean;
    isGroupChat?: boolean;
    wasMentioned?: boolean;
    hasReplyContext?: boolean;
    hasForwardedContext?: boolean;
    hasThreadStarter?: boolean;
    historyCount?: number;
  };
  sender?: {
    label?: string;
    id?: string;
    name?: string;
    username?: string;
    tag?: string;
    e164?: string;
  };
  thread?: {
    starterBody?: string;
    historyBody?: string;
  };
  reply?: {
    senderLabel?: string;
    isQuote?: boolean;
    body?: string;
  };
  forwarded?: {
    from?: string;
    type?: string;
    username?: string;
    title?: string;
    signature?: string;
    chatType?: string;
    dateMs?: number;
  };
  history?: Array<{
    sender?: string;
    timestampMs?: number;
    body?: string;
  }>;
};

export type PersistedUserMessageOverride = {
  content: string;
  contextSidecar?: ContextSidecar;
};

export type ContextSidecarProjectionLevel = "full" | "trim-history" | "trim-context";

type ContextSidecarProjectionOptions = {
  keepThreadStarterBody?: boolean;
};

const TRIM_HISTORY_MAX_ENTRIES = 2;
const TRIM_HISTORY_MAX_BODY_CHARS = 400;
const TRIM_REPLY_MAX_BODY_CHARS = 600;
const TRIM_FORWARDED_MAX_TITLE_CHARS = 120;
const TRIM_FORWARDED_MAX_SIGNATURE_CHARS = 160;
const TRIM_THREAD_STARTER_MAX_BODY_CHARS = 600;

type UserTextPart = {
  type: "text" | "input_text" | "output_text";
  text: string;
};

function hasDefinedValue(payload: Record<string, unknown>): boolean {
  return Object.values(payload).some((value) => value !== undefined && value !== null);
}

function pruneUndefined<T extends Record<string, unknown>>(payload: T): T | undefined {
  return hasDefinedValue(payload) ? payload : undefined;
}

export function safeTrim(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function truncateProjectionText(value: string | undefined, maxChars: number): string | undefined {
  if (!value) {
    return value;
  }
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function capProjectionHistory(
  history: ContextSidecar["history"],
): ContextSidecar["history"] | undefined {
  if (!history?.length) {
    return undefined;
  }
  const capped = history.slice(-TRIM_HISTORY_MAX_ENTRIES).map((entry) => ({
    ...entry,
    body: truncateProjectionText(entry.body, TRIM_HISTORY_MAX_BODY_CHARS),
  }));
  return capped.length > 0 ? capped : undefined;
}

function capProjectionReply(reply: ContextSidecar["reply"]): ContextSidecar["reply"] | undefined {
  if (!reply?.body) {
    return reply;
  }
  return pruneUndefined({
    senderLabel: reply.senderLabel,
    isQuote: reply.isQuote,
    body: truncateProjectionText(reply.body, TRIM_REPLY_MAX_BODY_CHARS),
  });
}

function capProjectionForwarded(
  forwarded: ContextSidecar["forwarded"],
): ContextSidecar["forwarded"] | undefined {
  if (!forwarded?.from) {
    return undefined;
  }
  return pruneUndefined({
    from: forwarded.from,
    type: forwarded.type,
    username: forwarded.username,
    title: truncateProjectionText(forwarded.title, TRIM_FORWARDED_MAX_TITLE_CHARS),
    signature: truncateProjectionText(forwarded.signature, TRIM_FORWARDED_MAX_SIGNATURE_CHARS),
    chatType: forwarded.chatType,
    dateMs: forwarded.dateMs,
  });
}

function capProjectionThread(
  thread: ContextSidecar["thread"],
  options: ContextSidecarProjectionOptions,
): ContextSidecar["thread"] | undefined {
  const keepThreadStarterBody = options.keepThreadStarterBody !== false;
  if (!keepThreadStarterBody || !thread?.starterBody) {
    return undefined;
  }
  return {
    starterBody: truncateProjectionText(thread.starterBody, TRIM_THREAD_STARTER_MAX_BODY_CHARS),
  };
}

function formatConversationTimestamp(
  value: unknown,
  envelope?: EnvelopeFormatOptions,
): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return formatEnvelopeTimestamp(value, envelope);
}

export function resolveInboundChannel(ctx: TemplateContext): string | undefined {
  let channelValue = safeTrim(ctx.OriginatingChannel) ?? safeTrim(ctx.Surface);
  if (!channelValue) {
    const provider = safeTrim(ctx.Provider);
    if (provider !== "webchat" && ctx.Surface !== "webchat") {
      channelValue = provider;
    }
  }
  return channelValue;
}

export function buildInboundContextSidecar(
  ctx: TemplateContext,
  envelope?: EnvelopeFormatOptions,
): ContextSidecar {
  const chatType = normalizeChatType(ctx.ChatType);
  const isDirect = !chatType || chatType === "direct";
  const directChannelValue = resolveInboundChannel(ctx);
  const includeDirectConversationInfo = Boolean(
    directChannelValue && directChannelValue !== "webchat",
  );
  const shouldIncludeConversationInfo = !isDirect || includeDirectConversationInfo;

  const messageId = safeTrim(ctx.MessageSid);
  const messageIdFull = safeTrim(ctx.MessageSidFull);
  const resolvedMessageId = messageId ?? messageIdFull;
  const timestamp = formatConversationTimestamp(ctx.Timestamp, envelope);

  const sender = pruneUndefined({
    label: resolveSenderLabel({
      name: safeTrim(ctx.SenderName),
      username: safeTrim(ctx.SenderUsername),
      tag: safeTrim(ctx.SenderTag),
      e164: safeTrim(ctx.SenderE164),
      id: safeTrim(ctx.SenderId),
    }),
    id: safeTrim(ctx.SenderId),
    name: safeTrim(ctx.SenderName),
    username: safeTrim(ctx.SenderUsername),
    tag: safeTrim(ctx.SenderTag),
    e164: safeTrim(ctx.SenderE164),
  });

  const reply = ctx.ReplyToBody
    ? pruneUndefined({
        senderLabel: safeTrim(ctx.ReplyToSender),
        isQuote: ctx.ReplyToIsQuote === true ? true : undefined,
        body: ctx.ReplyToBody,
      })
    : undefined;

  const thread = safeTrim(ctx.ThreadStarterBody)
    ? pruneUndefined({
        starterBody: ctx.ThreadStarterBody,
        historyBody: safeTrim(ctx.ThreadHistoryBody) ? ctx.ThreadHistoryBody : undefined,
      })
    : safeTrim(ctx.ThreadHistoryBody)
      ? pruneUndefined({
          historyBody: ctx.ThreadHistoryBody,
        })
      : undefined;

  const forwarded = ctx.ForwardedFrom
    ? pruneUndefined({
        from: safeTrim(ctx.ForwardedFrom),
        type: safeTrim(ctx.ForwardedFromType),
        username: safeTrim(ctx.ForwardedFromUsername),
        title: safeTrim(ctx.ForwardedFromTitle),
        signature: safeTrim(ctx.ForwardedFromSignature),
        chatType: safeTrim(ctx.ForwardedFromChatType),
        dateMs: typeof ctx.ForwardedDate === "number" ? ctx.ForwardedDate : undefined,
      })
    : undefined;

  const historyEntries = Array.isArray(ctx.InboundHistory)
    ? ctx.InboundHistory.map((entry) =>
        pruneUndefined({
          sender: entry.sender,
          timestampMs: entry.timestamp,
          body: entry.body,
        }),
      ).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    : undefined;
  const history = historyEntries && historyEntries.length > 0 ? historyEntries : undefined;

  const conversation = pruneUndefined({
    messageId: shouldIncludeConversationInfo ? resolvedMessageId : undefined,
    replyToId: shouldIncludeConversationInfo ? safeTrim(ctx.ReplyToId) : undefined,
    senderId: shouldIncludeConversationInfo ? safeTrim(ctx.SenderId) : undefined,
    conversationLabel: isDirect ? undefined : safeTrim(ctx.ConversationLabel),
    sender: shouldIncludeConversationInfo
      ? (safeTrim(ctx.SenderName) ??
        safeTrim(ctx.SenderE164) ??
        safeTrim(ctx.SenderId) ??
        safeTrim(ctx.SenderUsername))
      : undefined,
    timestamp,
    groupSubject: safeTrim(ctx.GroupSubject),
    groupChannel: safeTrim(ctx.GroupChannel),
    groupSpace: safeTrim(ctx.GroupSpace),
    threadLabel: safeTrim(ctx.ThreadLabel),
    topicId: ctx.MessageThreadId != null ? String(ctx.MessageThreadId) : undefined,
    isForum: ctx.IsForum === true ? true : undefined,
    isGroupChat: !isDirect ? true : undefined,
    wasMentioned: ctx.WasMentioned === true ? true : undefined,
    hasReplyContext: reply?.body ? true : undefined,
    hasForwardedContext: forwarded?.from ? true : undefined,
    hasThreadStarter: thread?.starterBody ? true : undefined,
    historyCount: history?.length,
  });

  return {
    formatVersion: 1,
    conversation,
    sender,
    thread,
    reply,
    forwarded,
    history,
  };
}

function serializeLegacyBlock(title: string, payload: unknown): string {
  return [title, "```json", JSON.stringify(payload, null, 2), "```"].join("\n");
}

function serializeLegacyConversation(
  conversation: NonNullable<ContextSidecar["conversation"]>,
): string | undefined {
  const legacyPayload = pruneUndefined({
    message_id: conversation.messageId,
    reply_to_id: conversation.replyToId,
    sender_id: conversation.senderId,
    conversation_label: conversation.conversationLabel,
    sender: conversation.sender,
    timestamp: conversation.timestamp,
    group_subject: conversation.groupSubject,
    group_channel: conversation.groupChannel,
    group_space: conversation.groupSpace,
    thread_label: conversation.threadLabel,
    topic_id: conversation.topicId,
    is_forum: conversation.isForum,
    is_group_chat: conversation.isGroupChat,
    was_mentioned: conversation.wasMentioned,
    has_reply_context: conversation.hasReplyContext,
    has_forwarded_context: conversation.hasForwardedContext,
    has_thread_starter: conversation.hasThreadStarter,
    history_count: conversation.historyCount,
  });
  return legacyPayload
    ? serializeLegacyBlock("Conversation info (untrusted metadata):", legacyPayload)
    : undefined;
}

function serializeLegacySender(sender: NonNullable<ContextSidecar["sender"]>): string | undefined {
  const legacyPayload = pruneUndefined({
    label: sender.label,
    id: sender.id,
    name: sender.name,
    username: sender.username,
    tag: sender.tag,
    e164: sender.e164,
  });
  return legacyPayload
    ? serializeLegacyBlock("Sender (untrusted metadata):", legacyPayload)
    : undefined;
}

export function serializeLegacyInboundContextPrefix(sidecar: ContextSidecar): string {
  const blocks = [
    sidecar.conversation ? serializeLegacyConversation(sidecar.conversation) : undefined,
    sidecar.sender ? serializeLegacySender(sidecar.sender) : undefined,
    sidecar.thread?.starterBody
      ? serializeLegacyBlock("Thread starter (untrusted, for context):", {
          body: sidecar.thread.starterBody,
        })
      : undefined,
    sidecar.reply?.body
      ? serializeLegacyBlock("Replied message (untrusted, for context):", {
          sender_label: sidecar.reply.senderLabel,
          is_quote: sidecar.reply.isQuote,
          body: sidecar.reply.body,
        })
      : undefined,
    sidecar.forwarded?.from
      ? serializeLegacyBlock("Forwarded message context (untrusted metadata):", {
          from: sidecar.forwarded.from,
          type: sidecar.forwarded.type,
          username: sidecar.forwarded.username,
          title: sidecar.forwarded.title,
          signature: sidecar.forwarded.signature,
          chat_type: sidecar.forwarded.chatType,
          date_ms: sidecar.forwarded.dateMs,
        })
      : undefined,
    sidecar.history?.length
      ? serializeLegacyBlock(
          "Chat history since last reply (untrusted, for context):",
          sidecar.history.map((entry) => ({
            sender: entry.sender,
            timestamp_ms: entry.timestampMs,
            body: entry.body,
          })),
        )
      : undefined,
  ].filter((block): block is string => Boolean(block));

  return blocks.join("\n\n");
}

export const buildContextSidecar = buildInboundContextSidecar;
export const serializeContextSidecarLegacy = serializeLegacyInboundContextPrefix;

export function normalizeContextSidecar(value: unknown): ContextSidecar | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return (value as { formatVersion?: unknown }).formatVersion === 1
    ? (value as ContextSidecar)
    : undefined;
}

function projectContextSidecar(
  sidecar: ContextSidecar,
  level: ContextSidecarProjectionLevel,
  options: ContextSidecarProjectionOptions = {},
): ContextSidecar {
  if (level === "full") {
    return sidecar;
  }

  if (level === "trim-history") {
    return {
      ...sidecar,
      forwarded: capProjectionForwarded(sidecar.forwarded),
      history: capProjectionHistory(sidecar.history),
      thread: capProjectionThread(sidecar.thread, options),
      conversation: sidecar.conversation
        ? {
            ...sidecar.conversation,
            hasForwardedContext:
              sidecar.conversation.hasForwardedContext ??
              (sidecar.forwarded?.from ? true : undefined),
            historyCount: sidecar.conversation.historyCount ?? sidecar.history?.length,
          }
        : undefined,
      reply: capProjectionReply(sidecar.reply),
    };
  }

  return {
    formatVersion: 1,
    conversation: pruneUndefined({
      sender: sidecar.conversation?.sender,
      timestamp: sidecar.conversation?.timestamp,
      isGroupChat: sidecar.conversation?.isGroupChat,
      wasMentioned: sidecar.conversation?.wasMentioned,
      hasReplyContext:
        sidecar.conversation?.hasReplyContext ?? (sidecar.reply?.body ? true : undefined),
      hasForwardedContext:
        sidecar.conversation?.hasForwardedContext ?? (sidecar.forwarded?.from ? true : undefined),
      hasThreadStarter:
        sidecar.conversation?.hasThreadStarter ?? (sidecar.thread?.starterBody ? true : undefined),
      historyCount: sidecar.conversation?.historyCount ?? sidecar.history?.length,
    }),
    sender: sidecar.sender
      ? pruneUndefined({
          label: sidecar.sender.label,
          id: sidecar.sender.id,
          name: sidecar.sender.name,
        })
      : undefined,
    reply: capProjectionReply(sidecar.reply),
  };
}

function isUserTextPart(value: unknown): value is UserTextPart {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as { type?: unknown; text?: unknown };
  return (
    (record.type === "text" || record.type === "input_text" || record.type === "output_text") &&
    typeof record.text === "string"
  );
}

function prependLegacyPrefixToContent(content: unknown, prefix: string): unknown {
  if (typeof content === "string") {
    return [prefix, content].filter(Boolean).join("\n\n");
  }
  if (!Array.isArray(content)) {
    return prefix;
  }

  let didPrepend = false;
  const next = content.map((part) => {
    if (!didPrepend && isUserTextPart(part)) {
      didPrepend = true;
      return {
        ...part,
        text: [prefix, part.text].filter(Boolean).join("\n\n"),
      };
    }
    return part;
  });
  if (didPrepend) {
    return next;
  }
  return [{ type: "text", text: prefix }, ...content];
}

export function applyPersistedUserMessageOverride(
  message: AgentMessage,
  override: PersistedUserMessageOverride | undefined,
): AgentMessage {
  if (!override) {
    return message;
  }
  if ((message as { role?: unknown }).role !== "user") {
    return message;
  }

  const record = message as unknown as Record<string, unknown>;
  const content = (() => {
    if (!Array.isArray(record["content"])) {
      return override.content;
    }

    const preservedNonText = (record["content"] as Array<Record<string, unknown>>).filter(
      (part) => {
        const type = part?.["type"];
        return type !== "text" && type !== "input_text" && type !== "output_text";
      },
    );
    if (!override.content.trim()) {
      return preservedNonText;
    }
    return [{ type: "text", text: override.content }, ...preservedNonText];
  })();
  const next: Record<string, unknown> = {
    ...record,
    content,
  };
  if (override.contextSidecar && next["contextSidecar"] === undefined) {
    next["contextSidecar"] = override.contextSidecar;
  }
  return next as AgentMessage;
}

export function projectHistoricalUserMessageWithContextSidecar(
  message: AgentMessage,
): AgentMessage {
  if ((message as { role?: unknown }).role !== "user") {
    return message;
  }

  const record = message as unknown as Record<string, unknown>;
  const sidecar = normalizeContextSidecar(record["contextSidecar"]);
  if (!sidecar) {
    return message;
  }

  const legacyPrefix = serializeLegacyInboundContextPrefix(sidecar);
  if (!legacyPrefix) {
    return message;
  }

  return {
    ...record,
    content: prependLegacyPrefixToContent(record["content"], legacyPrefix),
  } as AgentMessage;
}

export function projectHistoricalUserMessageWithContextSidecarLevel(
  message: AgentMessage,
  level: ContextSidecarProjectionLevel,
  options: ContextSidecarProjectionOptions = {},
): AgentMessage {
  if (level === "full") {
    return projectHistoricalUserMessageWithContextSidecar(message);
  }

  const record = message as unknown as Record<string, unknown>;
  const sidecar = normalizeContextSidecar(record["contextSidecar"]);
  if (!sidecar) {
    return message;
  }

  const legacyPrefix = serializeLegacyInboundContextPrefix(
    projectContextSidecar(sidecar, level, options),
  );
  if (!legacyPrefix) {
    return message;
  }

  return {
    ...record,
    content: prependLegacyPrefixToContent(record["content"], legacyPrefix),
  } as AgentMessage;
}

export function projectHistoricalMessagesWithContextSidecarBudget(
  messages: AgentMessage[],
  tokenBudget?: number,
): AgentMessage[] {
  const projectedMessages = messages.map((message) =>
    projectHistoricalUserMessageWithContextSidecar(message),
  );
  let next = projectedMessages.some((message, index) => message !== messages[index])
    ? projectedMessages
    : messages;

  if (!Number.isFinite(tokenBudget) || (tokenBudget ?? 0) <= 0) {
    return next;
  }
  if (estimateMessagesTokens(next) <= tokenBudget) {
    return next;
  }

  const sidecarUserIndexes = messages
    .map((message, index) =>
      message.role === "user" &&
      normalizeContextSidecar((message as Record<string, unknown>)["contextSidecar"])
        ? index
        : -1,
    )
    .filter((index) => index >= 0);
  if (sidecarUserIndexes.length === 0) {
    return next;
  }

  const olderIndexes = sidecarUserIndexes.slice(0, -1);
  if (olderIndexes.length === 0) {
    return next;
  }
  const latestOlderIndex = olderIndexes.at(-1);

  const applyAtIndexes = (
    indexes: number[],
    project: (message: AgentMessage, index: number) => AgentMessage,
  ): boolean => {
    let changed = false;
    const candidateMessages = next.slice();
    for (const index of indexes) {
      const candidate = project(messages[index], index);
      if (candidate !== candidateMessages[index]) {
        candidateMessages[index] = candidate;
        changed = true;
      }
    }
    if (changed) {
      next = candidateMessages;
    }
    return changed;
  };

  const projectionSteps = [
    () =>
      applyAtIndexes(olderIndexes, (message, index) =>
        projectHistoricalUserMessageWithContextSidecarLevel(message, "trim-history", {
          keepThreadStarterBody: index === latestOlderIndex,
        }),
      ),
    () =>
      applyAtIndexes(olderIndexes, (message) =>
        projectHistoricalUserMessageWithContextSidecarLevel(message, "trim-context"),
      ),
    () => applyAtIndexes(olderIndexes, (message) => message),
  ];

  for (const step of projectionSteps) {
    if (!step()) {
      continue;
    }
    if (estimateMessagesTokens(next) <= tokenBudget) {
      break;
    }
  }

  return next;
}

export function projectCompactionMessagesWithContextSidecarBudget(
  messages: AgentMessage[],
  tokenBudget?: number,
): AgentMessage[] {
  const projected = projectHistoricalMessagesWithContextSidecarBudget(messages, tokenBudget);
  const latestSidecarUserIndex = messages.findLastIndex(
    (message) =>
      message.role === "user" &&
      normalizeContextSidecar((message as Record<string, unknown>)["contextSidecar"]) !== undefined,
  );
  if (
    latestSidecarUserIndex < 0 ||
    projected[latestSidecarUserIndex] === messages[latestSidecarUserIndex]
  ) {
    return projected;
  }

  const next = projected.slice();
  next[latestSidecarUserIndex] = messages[latestSidecarUserIndex];
  return next;
}
