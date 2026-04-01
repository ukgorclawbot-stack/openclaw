import { registerLegacyContextEngine, registerSessionContextV2Engine } from "./legacy.js";

/**
 * Ensures all built-in context engines are registered exactly once.
 *
 * The built-in V2 engine is always registered as the default context-engine
 * slot, with the legacy id kept as a compatibility alias for older configs.
 *
 * Additional engines are registered by their own plugins via
 * `api.registerContextEngine()` during plugin load.
 */
let initialized = false;

export function ensureContextEnginesInitialized(): void {
  if (initialized) {
    return;
  }
  initialized = true;

  // Always available – built-in default plus the legacy compatibility alias.
  registerSessionContextV2Engine();
  registerLegacyContextEngine();
}
