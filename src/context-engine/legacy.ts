import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateMessagesTokens } from "../agents/compaction.js";
import {
  normalizeContextSidecar,
  projectHistoricalMessagesWithContextSidecarBudget,
  serializeLegacyInboundContextPrefix,
} from "../auto-reply/reply/context-sidecar.js";
import { delegateCompactionToRuntime } from "./delegate.js";
import { LEGACY_CONTEXT_ENGINE_ID, SESSION_CONTEXT_V2_ENGINE_ID } from "./ids.js";
import { registerContextEngineForOwner } from "./registry.js";
import type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  CompactResult,
  ContextEngineRuntimeContext,
  IngestResult,
} from "./types.js";

/**
 * SessionContextV2Engine keeps sidecar-backed context management behind the
 * ContextEngine interface while preserving legacy transcript compatibility.
 *
 * - ingest: no-op (SessionManager handles message persistence)
 * - assemble: projects older sidecar-backed turns inline, but routes the latest
 *   sidecar context through systemPromptAddition so prompt assembly is less
 *   coupled to transcript storage
 * - compact: delegates to compactEmbeddedPiSessionDirect
 */
export class SessionContextV2Engine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: SESSION_CONTEXT_V2_ENGINE_ID,
    name: "Session Context V2 Engine",
    version: "2.0.0",
  };

  async ingest(_params: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    // No-op: SessionManager handles message persistence in the legacy flow
    return { ingested: false };
  }

  async assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    tokenBudget?: number;
    model?: string;
  }): Promise<AssembleResult> {
    const latestSidecarPrompt = resolveLatestSidecarPrompt(params.messages);
    const hasFiniteTokenBudget = Number.isFinite(params.tokenBudget);
    const projectedMessages = projectHistoricalMessagesWithContextSidecarBudget(
      params.messages,
      hasFiniteTokenBudget
        ? Math.max(1, (params.tokenBudget ?? 0) - (latestSidecarPrompt?.tokens ?? 0))
        : params.tokenBudget,
    );
    const messages = latestSidecarPrompt
      ? projectedMessages.map((message, index) =>
          index === latestSidecarPrompt.index ? params.messages[index] : message,
        )
      : projectedMessages;

    return {
      messages,
      estimatedTokens: hasFiniteTokenBudget
        ? estimateMessagesTokens(messages) + (latestSidecarPrompt?.tokens ?? 0)
        : 0,
      systemPromptAddition: latestSidecarPrompt?.text,
    };
  }

  async afterTurn(_params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<void> {
    // No-op: legacy flow persists context directly in SessionManager.
  }

  async compact(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<CompactResult> {
    return await delegateCompactionToRuntime(params);
  }

  async dispose(): Promise<void> {
    // Nothing to clean up for legacy engine
  }
}

export class LegacyContextEngine extends SessionContextV2Engine {
  override readonly info: ContextEngineInfo = {
    id: LEGACY_CONTEXT_ENGINE_ID,
    name: "Legacy Context Engine",
    version: "1.0.0",
  };
}

export function registerSessionContextV2Engine(): void {
  registerContextEngineForOwner(
    SESSION_CONTEXT_V2_ENGINE_ID,
    () => new SessionContextV2Engine(),
    "core",
    {
      allowSameOwnerRefresh: true,
    },
  );
}

export function registerLegacyContextEngine(): void {
  registerContextEngineForOwner(LEGACY_CONTEXT_ENGINE_ID, () => new LegacyContextEngine(), "core", {
    allowSameOwnerRefresh: true,
  });
}

function findLatestSidecarUserMessageIndex(messages: AgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") {
      continue;
    }
    const sidecar = normalizeContextSidecar((message as Record<string, unknown>)["contextSidecar"]);
    if (sidecar) {
      return index;
    }
  }
  return -1;
}

function resolveLatestSidecarPrompt(
  messages: AgentMessage[],
): { index: number; text: string; tokens: number } | undefined {
  const latestSidecarIndex = findLatestSidecarUserMessageIndex(messages);
  if (latestSidecarIndex < 0) {
    return undefined;
  }
  const record = messages[latestSidecarIndex] as Record<string, unknown>;
  const latestSidecar = normalizeContextSidecar(record["contextSidecar"]);
  if (!latestSidecar) {
    return undefined;
  }
  const text = serializeLegacyInboundContextPrefix(latestSidecar);
  if (!text) {
    return undefined;
  }
  return {
    index: latestSidecarIndex,
    text,
    tokens: estimateMessagesTokens([{ role: "system", content: text } as AgentMessage]),
  };
}
