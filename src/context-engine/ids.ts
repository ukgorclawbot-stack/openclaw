export const SESSION_CONTEXT_V2_ENGINE_ID = "session-context-v2";
export const LEGACY_CONTEXT_ENGINE_ID = "legacy";

export const CORE_CONTEXT_ENGINE_IDS = [
  SESSION_CONTEXT_V2_ENGINE_ID,
  LEGACY_CONTEXT_ENGINE_ID,
] as const;

export function isCoreContextEngineId(id: string): boolean {
  return (CORE_CONTEXT_ENGINE_IDS as readonly string[]).includes(id);
}
