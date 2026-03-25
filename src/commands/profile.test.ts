import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readManagedProfile } from "../profiles/managed.js";
import { createNonExitingRuntime } from "../runtime.js";
import {
  profileCloneCommand,
  profileCreateCommand,
  profileDeleteCommand,
  profileDoctorCommand,
  profileImportCommand,
} from "./profile.js";

async function createTempProfileDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return fs.realpath(dir);
}

describe("profile commands", () => {
  const originalHome = process.env.OPENCLAW_HOME;
  const originalProfile = process.env.OPENCLAW_PROFILE;

  beforeEach(() => {
    delete process.env.OPENCLAW_PROFILE;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = originalHome;
    }
    if (originalProfile === undefined) {
      delete process.env.OPENCLAW_PROFILE;
    } else {
      process.env.OPENCLAW_PROFILE = originalProfile;
    }
  });

  it("creates a managed profile with manifest, config, state, and workspace", async () => {
    const root = await createTempProfileDir("openclaw-profile-create-");
    process.env.OPENCLAW_HOME = root;
    const runtime = createNonExitingRuntime();

    await profileCreateCommand(runtime, "rescue", {});

    const profile = await readManagedProfile("rescue", process.env, () => root);
    expect(profile).not.toBeNull();
    expect(profile?.configPath).toBe(
      path.join(root, ".openclaw", "profiles", "rescue", "config", "openclaw.json"),
    );
    expect(await fs.stat(profile!.stateDir)).toBeTruthy();
    expect(await fs.stat(profile!.workspaceDir)).toBeTruthy();
  });

  it("clones a profile with a fresh token and rewritten workspace", async () => {
    const root = await createTempProfileDir("openclaw-profile-clone-");
    process.env.OPENCLAW_HOME = root;
    const runtime = createNonExitingRuntime();

    await profileCreateCommand(runtime, "source", {});
    const source = await readManagedProfile("source", process.env, () => root);
    if (!source) {
      throw new Error("source profile missing");
    }
    await fs.writeFile(
      source.configPath,
      JSON.stringify(
        {
          agents: { defaults: { workspace: "/tmp/old-workspace" } },
          gateway: { auth: { mode: "token", token: "old-token" } },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.mkdir(path.join(source.stateDir, "logs"), { recursive: true });
    await fs.writeFile(path.join(source.stateDir, "logs", "gateway.log"), "noise", "utf8");
    await fs.mkdir(path.join(source.stateDir, "credentials"), { recursive: true });
    await fs.writeFile(path.join(source.stateDir, "credentials", "oauth.json"), "{}", "utf8");
    await fs.mkdir(path.join(source.stateDir, "profiles", "other"), { recursive: true });
    await fs.writeFile(
      path.join(source.stateDir, "profiles", "other", "profile.json"),
      "{}",
      "utf8",
    );
    await fs.mkdir(path.join(source.stateDir, "agents", "main", "agent"), { recursive: true });
    await fs.writeFile(
      path.join(source.stateDir, "agents", "main", "agent", "auth-profiles.json"),
      "{}",
      "utf8",
    );
    await fs.mkdir(path.join(source.stateDir, "agents", "main", "sessions"), { recursive: true });
    await fs.writeFile(
      path.join(source.stateDir, "agents", "main", "sessions", "turn.json"),
      "{}",
      "utf8",
    );

    await profileCloneCommand(runtime, "source", "clone", {});

    const clone = await readManagedProfile("clone", process.env, () => root);
    if (!clone) {
      throw new Error("clone profile missing");
    }
    const cloneConfig = JSON.parse(await fs.readFile(clone.configPath, "utf8")) as {
      agents?: { defaults?: { workspace?: string } };
      gateway?: { auth?: { token?: string } };
    };
    expect(cloneConfig.agents?.defaults?.workspace).toBe(clone.workspaceDir);
    expect(cloneConfig.gateway?.auth?.token).not.toBe("old-token");
    await expect(
      fs.stat(path.join(clone.stateDir, "credentials", "oauth.json")),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(clone.stateDir, "agents", "main", "agent", "auth-profiles.json")),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(clone.stateDir, "agents", "main", "sessions", "turn.json")),
    ).rejects.toThrow();
    await expect(fs.stat(path.join(clone.stateDir, "profiles"))).rejects.toThrow();
    await expect(fs.stat(path.join(clone.stateDir, "logs"))).rejects.toThrow();
  });

  it("preserves non-token auth modes during clone", async () => {
    const root = await createTempProfileDir("openclaw-profile-clone-auth-mode-");
    process.env.OPENCLAW_HOME = root;
    const runtime = createNonExitingRuntime();

    await profileCreateCommand(runtime, "source", {});
    const source = await readManagedProfile("source", process.env, () => root);
    if (!source) {
      throw new Error("source profile missing");
    }
    await fs.writeFile(
      source.configPath,
      JSON.stringify(
        {
          gateway: { auth: { mode: "trusted-proxy" } },
        },
        null,
        2,
      ),
      "utf8",
    );

    await profileCloneCommand(runtime, "source", "clone", {});

    const clone = await readManagedProfile("clone", process.env, () => root);
    if (!clone) {
      throw new Error("clone profile missing");
    }
    const cloneConfig = JSON.parse(await fs.readFile(clone.configPath, "utf8")) as {
      gateway?: { auth?: { mode?: string; token?: string } };
    };
    expect(cloneConfig.gateway?.auth?.mode).toBe("trusted-proxy");
    expect(cloneConfig.gateway?.auth?.token).toBeUndefined();
  });

  it("fails clone when the source config is unreadable", async () => {
    const root = await createTempProfileDir("openclaw-profile-clone-bad-source-");
    process.env.OPENCLAW_HOME = root;
    const runtime = createNonExitingRuntime();

    await profileCreateCommand(runtime, "source", {});
    const source = await readManagedProfile("source", process.env, () => root);
    if (!source) {
      throw new Error("source profile missing");
    }
    await fs.writeFile(source.configPath, "{not-json", "utf8");

    await expect(profileCloneCommand(runtime, "source", "clone", {})).rejects.toThrow(
      /source config is unreadable/i,
    );
    const clone = await readManagedProfile("clone", process.env, () => root);
    expect(clone).toBeNull();
  });

  it("skips symlinked state entries during clone", async () => {
    const root = await createTempProfileDir("openclaw-profile-clone-symlink-");
    process.env.OPENCLAW_HOME = root;
    const runtime = createNonExitingRuntime();

    await profileCreateCommand(runtime, "source", {});
    const source = await readManagedProfile("source", process.env, () => root);
    if (!source) {
      throw new Error("source profile missing");
    }
    await fs.writeFile(path.join(source.stateDir, "safe.json"), "{}", "utf8");
    await fs.symlink("/etc/hosts", path.join(source.stateDir, "leak.txt"));

    await profileCloneCommand(runtime, "source", "clone", {});

    const clone = await readManagedProfile("clone", process.env, () => root);
    if (!clone) {
      throw new Error("clone profile missing");
    }
    await expect(fs.stat(path.join(clone.stateDir, "safe.json"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(clone.stateDir, "leak.txt"))).rejects.toThrow();
  });

  it("copies state correctly when the source root is reached through a symlinked OPENCLAW_HOME", async () => {
    const realRoot = await createTempProfileDir("openclaw-profile-real-home-");
    const symlinkRoot = await createTempProfileDir("openclaw-profile-home-link-");
    const linkedHome = path.join(symlinkRoot, "linked-home");
    await fs.symlink(realRoot, linkedHome);

    process.env.OPENCLAW_HOME = linkedHome;
    const runtime = createNonExitingRuntime();

    await profileCreateCommand(runtime, "source", {});
    const source = await readManagedProfile("source", process.env, () => linkedHome);
    if (!source) {
      throw new Error("source profile missing");
    }
    await fs.mkdir(path.join(source.stateDir, "credentials"), { recursive: true });
    await fs.writeFile(path.join(source.stateDir, "credentials", "oauth.json"), "{}", "utf8");

    await profileCloneCommand(runtime, "source", "clone", {});

    const clone = await readManagedProfile("clone", process.env, () => linkedHome);
    if (!clone) {
      throw new Error("clone profile missing");
    }
    await expect(
      fs.stat(path.join(clone.stateDir, "credentials", "oauth.json")),
    ).resolves.toBeTruthy();
  });

  it("doctor warns when config workspace escapes the managed workspace root", async () => {
    const root = await createTempProfileDir("openclaw-profile-doctor-");
    process.env.OPENCLAW_HOME = root;
    const runtime = createNonExitingRuntime();

    await profileCreateCommand(runtime, "doctor-test", {});
    const profile = await readManagedProfile("doctor-test", process.env, () => root);
    if (!profile) {
      throw new Error("doctor-test profile missing");
    }
    await fs.writeFile(
      profile.configPath,
      JSON.stringify({ agents: { defaults: { workspace: "/tmp/external" } } }, null, 2),
      "utf8",
    );

    const lines: string[] = [];
    runtime.log = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    };

    await profileDoctorCommand(runtime, "doctor-test", { json: false });

    expect(lines.join("\n")).toContain(
      "agents.defaults.workspace diverges from the managed profile workspace",
    );
  });

  it("imports a legacy named profile without changing its effective roots", async () => {
    const root = await createTempProfileDir("openclaw-profile-import-");
    process.env.OPENCLAW_HOME = root;
    const runtime = createNonExitingRuntime();
    const legacyRoot = path.join(root, ".openclaw-legacy");
    await fs.mkdir(path.join(legacyRoot, "credentials"), { recursive: true });
    await fs.writeFile(
      path.join(legacyRoot, "openclaw.json"),
      JSON.stringify({ agents: { defaults: { workspace: "/tmp/legacy" } } }, null, 2),
      "utf8",
    );
    await fs.writeFile(path.join(legacyRoot, "credentials", "oauth.json"), "{}", "utf8");

    await profileImportCommand(runtime, "legacy", {});

    const managed = await readManagedProfile("legacy", process.env, () => root);
    expect(managed).not.toBeNull();
    expect(managed?.mode).toBe("adopted-legacy");
    expect(managed?.stateDir).toBe(legacyRoot);
    expect(managed?.configPath).toBe(path.join(legacyRoot, "openclaw.json"));
    await expect(fs.stat(path.join(legacyRoot, "credentials", "oauth.json"))).resolves.toBeTruthy();
  });

  it("refuses to import when a same-id managed manifest already exists but is unreadable", async () => {
    const root = await createTempProfileDir("openclaw-profile-import-bad-manifest-");
    process.env.OPENCLAW_HOME = root;
    const runtime = createNonExitingRuntime();
    const legacyRoot = path.join(root, ".openclaw-legacy");
    await fs.mkdir(legacyRoot, { recursive: true });
    await fs.writeFile(path.join(legacyRoot, "openclaw.json"), "{}", "utf8");

    const profileRoot = path.join(root, ".openclaw", "profiles", "legacy");
    await fs.mkdir(profileRoot, { recursive: true });
    await fs.writeFile(path.join(profileRoot, "profile.json"), "{not-json", "utf8");

    await expect(profileImportCommand(runtime, "legacy", {})).rejects.toThrow(
      /manifest exists but is unreadable/i,
    );
  });

  it("refuses to import a symlinked legacy profile root", async () => {
    const root = await createTempProfileDir("openclaw-profile-import-symlink-");
    process.env.OPENCLAW_HOME = root;
    const runtime = createNonExitingRuntime();
    const external = await createTempProfileDir("openclaw-profile-external-");
    await fs.symlink(external, path.join(root, ".openclaw-legacy"));

    await expect(profileImportCommand(runtime, "legacy", {})).rejects.toThrow(
      /legacy profile not found/i,
    );
  });

  it("treats absolute managed-native roots as invalid manifests", async () => {
    const root = await createTempProfileDir("openclaw-profile-absolute-roots-");
    process.env.OPENCLAW_HOME = root;
    const runtime = createNonExitingRuntime();

    await profileCreateCommand(runtime, "native", {});
    const manifestPath = path.join(root, ".openclaw", "profiles", "native", "profile.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      roots: { config: string; state: string; workspace: string };
    };
    manifest.roots.config = "/tmp/escape-config.json";
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    const managed = await readManagedProfile("native", process.env, () => root);
    expect(managed?.warnings.join("\n")).toContain("Absolute profile paths are not allowed");
  });

  it("treats adopted legacy manifests that escape the adopted root as invalid", async () => {
    const root = await createTempProfileDir("openclaw-profile-adopted-escape-");
    process.env.OPENCLAW_HOME = root;
    const runtime = createNonExitingRuntime();
    const legacyRoot = path.join(root, ".openclaw-legacy");
    await fs.mkdir(legacyRoot, { recursive: true });
    await fs.writeFile(path.join(legacyRoot, "openclaw.json"), "{}", "utf8");

    await profileImportCommand(runtime, "legacy", {});

    const manifestPath = path.join(root, ".openclaw", "profiles", "legacy", "profile.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      roots: { config: string; state: string; workspace: string };
    };
    manifest.roots.state = "/tmp/escape-state";
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    const managed = await readManagedProfile("legacy", process.env, () => root);
    expect(managed?.warnings.join("\n")).toContain("escapes adopted legacy root");
    expect(managed?.stateDir).toBe("/tmp/escape-state");
    expect(managed?.configPath).toBe(path.join(legacyRoot, "openclaw.json"));
  });

  it("refuses to create a managed profile when a same-id legacy profile exists", async () => {
    const root = await createTempProfileDir("openclaw-profile-shadow-");
    process.env.OPENCLAW_HOME = root;
    const runtime = createNonExitingRuntime();
    await fs.mkdir(path.join(root, ".openclaw-shadow"), { recursive: true });

    await expect(profileCreateCommand(runtime, "shadow", {})).rejects.toThrow(
      /profile import shadow/i,
    );
  });

  it("refuses to create when a managed manifest already exists but is unreadable", async () => {
    const root = await createTempProfileDir("openclaw-profile-bad-manifest-");
    process.env.OPENCLAW_HOME = root;
    const runtime = createNonExitingRuntime();
    const profileRoot = path.join(root, ".openclaw", "profiles", "broken");
    await fs.mkdir(profileRoot, { recursive: true });
    await fs.writeFile(path.join(profileRoot, "profile.json"), "{not-json", "utf8");

    await expect(profileCreateCommand(runtime, "broken", {})).rejects.toThrow(
      /manifest exists but is unreadable/i,
    );
  });

  it("refuses to clone into a destination id already used by a legacy profile", async () => {
    const root = await createTempProfileDir("openclaw-profile-clone-shadow-");
    process.env.OPENCLAW_HOME = root;
    const runtime = createNonExitingRuntime();

    await profileCreateCommand(runtime, "source", {});
    await fs.mkdir(path.join(root, ".openclaw-shadow"), { recursive: true });

    await expect(profileCloneCommand(runtime, "source", "shadow", {})).rejects.toThrow(
      /profile import shadow/i,
    );
  });

  it("refuses to clone when a destination managed manifest already exists but is unreadable", async () => {
    const root = await createTempProfileDir("openclaw-profile-clone-bad-manifest-");
    process.env.OPENCLAW_HOME = root;
    const runtime = createNonExitingRuntime();

    await profileCreateCommand(runtime, "source", {});
    const profileRoot = path.join(root, ".openclaw", "profiles", "broken");
    await fs.mkdir(profileRoot, { recursive: true });
    await fs.writeFile(path.join(profileRoot, "profile.json"), "{not-json", "utf8");

    await expect(profileCloneCommand(runtime, "source", "broken", {})).rejects.toThrow(
      /manifest exists but is unreadable/i,
    );
  });

  it("avoids reusing dev's preferred port when another profile already occupies it", async () => {
    const root = await createTempProfileDir("openclaw-profile-dev-port-");
    process.env.OPENCLAW_HOME = root;
    const runtime = createNonExitingRuntime();

    await profileCreateCommand(runtime, "work", {});
    const work = await readManagedProfile("work", process.env, () => root);
    expect(work?.basePort).toBe(19001);

    await profileCreateCommand(runtime, "dev", {});

    const dev = await readManagedProfile("dev", process.env, () => root);
    expect(dev?.basePort).toBeDefined();
    expect(dev?.basePort).not.toBe(work?.basePort);
  });

  it("rejects invalid profile ids instead of coercing them to default", async () => {
    const root = await createTempProfileDir("openclaw-profile-invalid-id-");
    process.env.OPENCLAW_HOME = root;
    const runtime = createNonExitingRuntime();

    await expect(profileCreateCommand(runtime, "bad profile", {})).rejects.toThrow(
      /invalid profile id/i,
    );
    await expect(profileDeleteCommand(runtime, "bad profile", { yes: true })).rejects.toThrow(
      /invalid profile id/i,
    );
  });

  it("refuses to delete the active profile without force", async () => {
    const root = await createTempProfileDir("openclaw-profile-delete-");
    process.env.OPENCLAW_HOME = root;
    process.env.OPENCLAW_PROFILE = "active";
    const runtime = createNonExitingRuntime();

    await profileCreateCommand(runtime, "active", {});

    await expect(profileDeleteCommand(runtime, "active", { yes: true })).rejects.toThrow(
      /live profile|active CLI environment/i,
    );
  });

  it("treats OPENCLAW_PROFILE casing aliases as live-profile matches during delete", async () => {
    const root = await createTempProfileDir("openclaw-profile-delete-case-");
    process.env.OPENCLAW_HOME = root;
    process.env.OPENCLAW_PROFILE = "Default";
    const runtime = createNonExitingRuntime();

    await profileCreateCommand(runtime, "default", {});

    await expect(profileDeleteCommand(runtime, "default", { yes: true })).rejects.toThrow(
      /live profile|active CLI environment/i,
    );
  });

  it("refuses to delete a profile when the active env points at its config/state roots", async () => {
    const root = await createTempProfileDir("openclaw-profile-delete-override-");
    process.env.OPENCLAW_HOME = root;
    const runtime = createNonExitingRuntime();

    await profileCreateCommand(runtime, "override", {});
    const profile = await readManagedProfile("override", process.env, () => root);
    if (!profile) {
      throw new Error("override profile missing");
    }

    delete process.env.OPENCLAW_PROFILE;
    process.env.OPENCLAW_STATE_DIR = profile.stateDir;

    await expect(profileDeleteCommand(runtime, "override", { yes: true })).rejects.toThrow(
      /state dir matches the active CLI environment/i,
    );
  });

  it("refuses to delete a profile when the active env reaches its state dir through a symlink", async () => {
    const root = await createTempProfileDir("openclaw-profile-delete-symlink-");
    process.env.OPENCLAW_HOME = root;
    const runtime = createNonExitingRuntime();

    await profileCreateCommand(runtime, "linked", {});
    const profile = await readManagedProfile("linked", process.env, () => root);
    if (!profile) {
      throw new Error("linked profile missing");
    }

    const symlinkPath = path.join(root, "linked-state");
    await fs.symlink(profile.stateDir, symlinkPath);

    delete process.env.OPENCLAW_PROFILE;
    process.env.OPENCLAW_STATE_DIR = symlinkPath;

    await expect(profileDeleteCommand(runtime, "linked", { yes: true })).rejects.toThrow(
      /state dir matches the active CLI environment/i,
    );
  });
});
