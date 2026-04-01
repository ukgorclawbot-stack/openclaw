export type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  CompactResult,
  ContextEngineMaintenanceResult,
  ContextEngineRuntimeContext,
  IngestResult,
  TranscriptRewriteReplacement,
  TranscriptRewriteRequest,
  TranscriptRewriteResult,
} from "./types.js";

export {
  registerContextEngine,
  getContextEngineFactory,
  listContextEngineIds,
  resolveContextEngine,
} from "./registry.js";
export type { ContextEngineFactory } from "./registry.js";

export {
  LegacyContextEngine,
  SessionContextV2Engine,
  registerLegacyContextEngine,
  registerSessionContextV2Engine,
} from "./legacy.js";
export {
  CORE_CONTEXT_ENGINE_IDS,
  LEGACY_CONTEXT_ENGINE_ID,
  SESSION_CONTEXT_V2_ENGINE_ID,
  isCoreContextEngineId,
} from "./ids.js";
export { delegateCompactionToRuntime } from "./delegate.js";

export { ensureContextEnginesInitialized } from "./init.js";
