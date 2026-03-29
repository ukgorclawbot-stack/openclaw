import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const mocks = vi.hoisted(() => ({
  memoryRegister: vi.fn(),
  otherRegister: vi.fn(),
  loadOpenClawPlugins: vi.fn(),
  applyPluginAutoEnable: vi.fn(),
  reparseProgramFromActionArgs: vi.fn(),
}));

vi.mock("./loader.js", () => ({
  loadOpenClawPlugins: (...args: unknown[]) => mocks.loadOpenClawPlugins(...args),
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => mocks.applyPluginAutoEnable(...args),
}));

vi.mock("../cli/program/action-reparse.js", () => ({
  reparseProgramFromActionArgs: (...args: unknown[]) => mocks.reparseProgramFromActionArgs(...args),
}));

import { registerPluginCliCommands } from "./cli.js";

function createProgram(existingCommandName?: string) {
  const program = new Command();
  if (existingCommandName) {
    program.command(existingCommandName);
  }
  return program;
}

function createCliRegistry() {
  return {
    cliRegistrars: [
      {
        pluginId: "memory-core",
        register: mocks.memoryRegister,
        commands: ["memory"],
        descriptors: [],
        source: "bundled",
      },
      {
        pluginId: "other",
        register: mocks.otherRegister,
        commands: ["other"],
        descriptors: [],
        source: "bundled",
      },
    ],
  };
}

function expectPluginLoaderConfig(config: OpenClawConfig) {
  expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
    expect.objectContaining({
      config,
    }),
  );
}

function createAutoEnabledCliFixture() {
  const rawConfig = {
    plugins: {},
    channels: { demo: { enabled: true } },
  } as OpenClawConfig;
  const autoEnabledConfig = {
    ...rawConfig,
    plugins: {
      entries: {
        demo: { enabled: true },
      },
    },
  } as OpenClawConfig;
  return { rawConfig, autoEnabledConfig };
}

function expectAutoEnabledCliLoad(params: {
  rawConfig: OpenClawConfig;
  autoEnabledConfig: OpenClawConfig;
}) {
  expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
    config: params.rawConfig,
    env: process.env,
  });
  expectPluginLoaderConfig(params.autoEnabledConfig);
}

function expectCliRegistrarCalledWithConfig(config: OpenClawConfig) {
  expect(mocks.memoryRegister).toHaveBeenCalledWith(
    expect.objectContaining({
      config,
    }),
  );
}

function runRegisterPluginCliCommands(params: {
  existingCommandName?: string;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}) {
  const program = createProgram(params.existingCommandName);
  registerPluginCliCommands(program, params.config, params.env);
  return program;
}

describe("registerPluginCliCommands", () => {
  beforeEach(() => {
    mocks.memoryRegister.mockClear();
    mocks.otherRegister.mockClear();
    mocks.loadOpenClawPlugins.mockReset();
    mocks.loadOpenClawPlugins.mockReturnValue(createCliRegistry());
    mocks.applyPluginAutoEnable.mockReset();
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
    mocks.reparseProgramFromActionArgs.mockReset();
    mocks.reparseProgramFromActionArgs.mockResolvedValue(undefined);
  });

  it("skips plugin CLI registrars when commands already exist", () => {
    runRegisterPluginCliCommands({
      existingCommandName: "memory",
      config: {} as OpenClawConfig,
    });

    expect(mocks.memoryRegister).not.toHaveBeenCalled();
    expect(mocks.otherRegister).toHaveBeenCalledTimes(1);
  });

  it("forwards an explicit env to plugin loading", () => {
    const env = { OPENCLAW_HOME: "/srv/openclaw-home" } as NodeJS.ProcessEnv;

    runRegisterPluginCliCommands({
      config: {} as OpenClawConfig,
      env,
    });

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
      }),
    );
  });

  it("loads plugin CLI commands from the auto-enabled config snapshot", () => {
    const { rawConfig, autoEnabledConfig } = createAutoEnabledCliFixture();
    mocks.applyPluginAutoEnable.mockReturnValue({ config: autoEnabledConfig, changes: [] });

    runRegisterPluginCliCommands({
      config: rawConfig,
    });

    expectAutoEnabledCliLoad({ rawConfig, autoEnabledConfig });
    expectCliRegistrarCalledWithConfig(autoEnabledConfig);
  });

  it("registers descriptor-backed plugin commands lazily when requested", async () => {
    mocks.loadOpenClawPlugins.mockReturnValue({
      cliRegistrars: [
        {
          pluginId: "memory-core",
          register: ({ program }: { program: Command }) => {
            mocks.memoryRegister();
            program.command("memory").action(() => {});
          },
          commands: ["memory"],
          descriptors: [
            {
              name: "memory",
              description: "Search, inspect, and reindex memory files",
              hasSubcommands: true,
            },
          ],
          source: "bundled",
        },
      ],
    });

    const program = createProgram();
    registerPluginCliCommands(program, {} as OpenClawConfig, undefined, undefined, {
      mode: "lazy",
    });

    expect(mocks.memoryRegister).not.toHaveBeenCalled();
    expect(program.commands.map((command) => command.name())).toContain("memory");

    const placeholder = program.commands.find((command) => command.name() === "memory") as
      | (Command & { _actionHandler?: (...args: unknown[]) => Promise<void> | void })
      | undefined;
    await placeholder?._actionHandler?.(placeholder);

    expect(mocks.memoryRegister).toHaveBeenCalledTimes(1);
    expect(mocks.reparseProgramFromActionArgs).toHaveBeenCalledTimes(1);
  });
});
