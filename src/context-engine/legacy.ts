import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateMessagesTokens } from "../agents/compaction.js";
import { projectHistoricalMessagesWithContextSidecarBudget } from "../auto-reply/reply/context-sidecar.js";
import { delegateCompactionToRuntime } from "./delegate.js";
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
 * LegacyContextEngine wraps the existing compaction behavior behind the
 * ContextEngine interface, preserving 100% backward compatibility.
 *
 * - ingest: no-op (SessionManager handles message persistence)
 * - assemble: pass-through (existing sanitize/validate/limit pipeline in attempt.ts handles this)
 * - compact: delegates to compactEmbeddedPiSessionDirect
 */
export class LegacyContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "legacy",
    name: "Legacy Context Engine",
    version: "1.0.0",
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
    const messages = projectHistoricalMessagesWithContextSidecarBudget(
      params.messages,
      params.tokenBudget,
    );

    return {
      messages,
      estimatedTokens: params.tokenBudget ? estimateMessagesTokens(messages) : 0,
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

export function registerLegacyContextEngine(): void {
  registerContextEngineForOwner("legacy", () => new LegacyContextEngine(), "core", {
    allowSameOwnerRefresh: true,
  });
}
