import type { Command } from "commander";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { reparseProgramFromActionArgs } from "../cli/program/action-reparse.js";
import { removeCommandByName } from "../cli/program/command-tree.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { loadOpenClawPlugins, type PluginLoadOptions } from "./loader.js";
import type { OpenClawPluginCliCommandDescriptor } from "./types.js";
import type { PluginLogger } from "./types.js";

const log = createSubsystemLogger("plugins");

type PluginCliRegistrationMode = "eager" | "lazy";

type RegisterPluginCliOptions = {
  mode?: PluginCliRegistrationMode;
};

function loadPluginCliRegistry(
  cfg?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
  loaderOptions?: Pick<PluginLoadOptions, "pluginSdkResolution">,
) {
  const config = cfg ?? loadConfig();
  const resolvedConfig = applyPluginAutoEnable({ config, env: env ?? process.env }).config;
  const workspaceDir = resolveAgentWorkspaceDir(
    resolvedConfig,
    resolveDefaultAgentId(resolvedConfig),
  );
  const logger: PluginLogger = {
    info: (msg: string) => log.info(msg),
    warn: (msg: string) => log.warn(msg),
    error: (msg: string) => log.error(msg),
    debug: (msg: string) => log.debug(msg),
  };
  return {
    config: resolvedConfig,
    workspaceDir,
    logger,
    registry: loadOpenClawPlugins({
      config: resolvedConfig,
      workspaceDir,
      env,
      logger,
      ...loaderOptions,
    }),
  };
}

export function getPluginCliCommandDescriptors(
  cfg?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): OpenClawPluginCliCommandDescriptor[] {
  try {
    const { registry } = loadPluginCliRegistry(cfg, env);
    const seen = new Set<string>();
    const descriptors: OpenClawPluginCliCommandDescriptor[] = [];
    for (const entry of registry.cliRegistrars) {
      for (const descriptor of entry.descriptors) {
        if (seen.has(descriptor.name)) {
          continue;
        }
        seen.add(descriptor.name);
        descriptors.push(descriptor);
      }
    }
    return descriptors;
  } catch {
    return [];
  }
}

export function registerPluginCliCommands(
  program: Command,
  cfg?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
  loaderOptions?: Pick<PluginLoadOptions, "pluginSdkResolution">,
  options?: RegisterPluginCliOptions,
) {
  const { config, workspaceDir, logger, registry } = loadPluginCliRegistry(cfg, env, loaderOptions);
  const mode = options?.mode ?? "eager";

  const existingCommands = new Set(program.commands.map((cmd) => cmd.name()));

  for (const entry of registry.cliRegistrars) {
    if (entry.commands.length > 0) {
      const overlaps = entry.commands.filter((command) => existingCommands.has(command));
      if (overlaps.length > 0) {
        log.debug(
          `plugin CLI register skipped (${entry.pluginId}): command already registered (${overlaps.join(
            ", ",
          )})`,
        );
        continue;
      }
    }
    try {
      const registerEntry = () =>
        entry.register({
          program,
          config,
          workspaceDir,
          logger,
        });
      if (mode === "lazy" && entry.descriptors.length > 0) {
        for (const descriptor of entry.descriptors) {
          const placeholder = program.command(descriptor.name).description(descriptor.description);
          placeholder.allowUnknownOption(true);
          placeholder.allowExcessArguments(true);
          placeholder.action(async (...actionArgs) => {
            for (const command of entry.commands) {
              removeCommandByName(program, command);
            }
            await registerEntry();
            await reparseProgramFromActionArgs(program, actionArgs);
          });
        }
      } else {
        const result = registerEntry();
        if (result && typeof result.then === "function") {
          void result.catch((err) => {
            log.warn(`plugin CLI register failed (${entry.pluginId}): ${String(err)}`);
          });
        }
      }
      for (const command of entry.commands) {
        existingCommands.add(command);
      }
    } catch (err) {
      log.warn(`plugin CLI register failed (${entry.pluginId}): ${String(err)}`);
    }
  }
}
