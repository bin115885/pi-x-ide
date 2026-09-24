import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent" with {
  "resolution-mode": "import",
};
import {
  buildInstallArgs,
  compareExtensionVersions,
  LOCAL_VSCODE_EXTENSION_ID,
  LOCAL_VSCODE_VERSION,
  inferCurrentIdeFromEnv,
  isAutoInstallEnabled,
  parseInstalledExtensionVersion,
  PI_X_IDE_EXTENSION_ID,
  selectAutoInstallCandidate,
  type IdeInstallCandidate,
} from "../src/pi/install.js";
import {
  DEFAULT_ATTACH_SHORTCUT,
  PI_X_IDE_ATTACH_SHORTCUT_ENV,
  registerIdeCommand,
  resolveAttachShortcut,
} from "../src/pi/commands.js";
import { createRuntime } from "../src/pi/state.js";
import { CONFIG_DIR_NAME, resolvePiConfigEnv } from "../src/shared/config.js";

void test("checks auto-install env gate", () => {
  assert.equal(isAutoInstallEnabled({}), false);
  assert.equal(isAutoInstallEnabled({ TERM_PROGRAM: "vscode" }), true);
  assert.equal(isAutoInstallEnabled({ TERM_PROGRAM: "vscode", CURSOR_TRACE_ID: "trace" }), false);
  assert.equal(isAutoInstallEnabled({ TERM_PROGRAM: "vscode", PI_X_IDE_AUTO_INSTALL: "0" }), false);
  assert.equal(isAutoInstallEnabled({ PI_X_IDE_AUTO_INSTALL: "0" }), false);
  assert.equal(isAutoInstallEnabled({ PI_X_IDE_AUTO_INSTALL: "false" }), false);
  assert.equal(isAutoInstallEnabled({ PI_X_IDE_AUTO_INSTALL: "OFF" }), false);
  assert.equal(isAutoInstallEnabled({ PI_X_IDE_AUTO_INSTALL: "1" }), true);
  assert.equal(isAutoInstallEnabled({ PI_X_IDE_AUTO_INSTALL: "true" }), true);
});

void test("checks auto-install env gate from pi config", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-x-ide-install-config-"));
  const configDir = join(home, CONFIG_DIR_NAME);
  const configPath = join(configDir, "config.json");
  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, JSON.stringify({ env: { PI_X_IDE_AUTO_INSTALL: "off" } }));

  assert.equal(isAutoInstallEnabled(resolvePiConfigEnv({}, { configPath })), false);
  assert.equal(isAutoInstallEnabled(resolvePiConfigEnv({ PI_X_IDE_AUTO_INSTALL: "true" }, { configPath })), true);
});

void test("parses installed extension versions", () => {
  const output = ["publisher.other@0.1.0", "balaenis.pi-x-ide@1.2.3", "BALAENIS.PI-X-IDE@1.2.4"].join("\n");

  assert.equal(parseInstalledExtensionVersion(output), "1.2.3");
  assert.equal(parseInstalledExtensionVersion("qd.pi-x-ide@1.19.3", LOCAL_VSCODE_EXTENSION_ID), "1.19.3");
  assert.equal(parseInstalledExtensionVersion("publisher.other@0.1.0"), undefined);
});

void test("compares stable extension versions", () => {
  assert.equal(compareExtensionVersions("1.0.4", "1.0.5"), "older");
  assert.equal(compareExtensionVersions("1.0.5", "1.0.5"), "equal");
  assert.equal(compareExtensionVersions("1.0.6", "1.0.5"), "newer");
  assert.equal(compareExtensionVersions("1.1.0", "1.0.5"), "newer");
  assert.equal(compareExtensionVersions("not-a-version", "1.0.5"), "unknown");
  assert.equal(compareExtensionVersions(undefined, "1.0.5"), "unknown");
});

void test("infers current IDE from terminal environment conservatively", () => {
  assert.equal(inferCurrentIdeFromEnv({ TERM_PROGRAM: "vscode", VSCODE_PID: "123" }), "vscode");
  assert.equal(inferCurrentIdeFromEnv({ TERM_PROGRAM: "vscode", CURSOR_TRACE_ID: "trace" }), "cursor");
  assert.equal(inferCurrentIdeFromEnv({ TERM_PROGRAM: "vscode", WINDSURF_BIN: "1" }), "windsurf");
  assert.equal(inferCurrentIdeFromEnv({ CURSOR_TRACE_ID: "trace", WINDSURF_BIN: "1" }), undefined);
  assert.equal(inferCurrentIdeFromEnv({}), undefined);
});

void test("selects only one high-confidence auto-install candidate", () => {
  const vscode = createCandidate({ id: "vscode", confidence: "current-terminal" });
  const cursor = createCandidate({ id: "cursor", confidence: "current-terminal", cli: "cursor", label: "Cursor" });
  const available = createCandidate({ id: "vscode", confidence: "available-cli" });
  const unknown = createCandidate({ id: "vscode", confidence: "current-terminal", reason: "unknown" });

  assert.equal(selectAutoInstallCandidate([vscode], { TERM_PROGRAM: "vscode" }), vscode);
  assert.equal(selectAutoInstallCandidate([available], { TERM_PROGRAM: "vscode" }), undefined);
  assert.equal(selectAutoInstallCandidate([unknown], { TERM_PROGRAM: "vscode" }), undefined);
  assert.equal(selectAutoInstallCandidate([vscode, cursor], {}), undefined);
  assert.equal(selectAutoInstallCandidate([cursor], { CURSOR_TRACE_ID: "trace" }), cursor);
});

void test("installs the bundled local VS Code extension only for VS Code", () => {
  const args = buildInstallArgs({ id: "vscode" });
  assert.deepEqual(args.slice(0, 2), ["--force", "--install-extension"]);
  assert.equal(args[2]?.endsWith(`${LOCAL_VSCODE_EXTENSION_ID}-${LOCAL_VSCODE_VERSION}.vsix`), true);
  assert.deepEqual(buildInstallArgs({ id: "cursor" }), ["--force", "--install-extension", PI_X_IDE_EXTENSION_ID]);
});

void test("resolves configurable Pi TUI attach shortcut", () => {
  assert.equal(resolveAttachShortcut({}), DEFAULT_ATTACH_SHORTCUT);
  assert.equal(resolveAttachShortcut({ [PI_X_IDE_ATTACH_SHORTCUT_ENV]: "Ctrl+Shift+I" }), "ctrl+shift+i");
  assert.equal(resolveAttachShortcut({ [PI_X_IDE_ATTACH_SHORTCUT_ENV]: "off" }), undefined);
  assert.equal(resolveAttachShortcut({ [PI_X_IDE_ATTACH_SHORTCUT_ENV]: "0" }), undefined);
});

void test("/ide disconnect awaits the async action before completing", async () => {
  type RegisteredCommand = {
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  };

  let registered: RegisteredCommand | undefined;
  let disconnectStarted = false;
  let resolveDisconnect!: () => void;
  const disconnectGate = new Promise<void>((resolve) => {
    resolveDisconnect = resolve;
  });

  const pi = {
    registerCommand: (_name: string, command: RegisteredCommand) => {
      registered = command;
    },
    registerShortcut: () => {},
  } as unknown as ExtensionAPI;

  registerIdeCommand(pi, createRuntime(), {
    refreshCandidates: () => Promise.resolve([]),
    connectAuto: () => Promise.resolve(),
    connectCandidate: () => Promise.resolve(),
    disconnect: async () => {
      disconnectStarted = true;
      await disconnectGate;
    },
  });

  assert.ok(registered);
  let handlerDone = false;
  const handlerPromise = registered.handler("off", createCommandContext()).then(() => {
    handlerDone = true;
  });

  await Promise.resolve();
  assert.equal(disconnectStarted, true);
  assert.equal(handlerDone, false);

  resolveDisconnect();
  await handlerPromise;
  assert.equal(handlerDone, true);
});

void test("/ide install is not exposed", async () => {
  let registered:
    | {
        getArgumentCompletions: (prefix: string) => { value: string }[] | null;
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      }
    | undefined;
  const notifications: string[] = [];
  const pi = {
    registerCommand: (_name: string, command: typeof registered) => {
      registered = command;
    },
    registerShortcut: () => {},
  } as unknown as ExtensionAPI;
  registerIdeCommand(pi, createRuntime(), {
    refreshCandidates: () => Promise.resolve([]),
    connectAuto: () => Promise.resolve(),
    connectCandidate: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
  });
  assert.ok(registered);
  assert.equal(
    registered.getArgumentCompletions("")?.some(({ value }) => value === "install"),
    false,
  );
  const ctx = createCommandContext();
  ctx.ui.notify = (message) => {
    notifications.push(message);
  };
  await registered.handler("install", ctx);
  assert.match(notifications[0] ?? "", /Usage: \/ide/);
});

function createCandidate(overrides: Partial<IdeInstallCandidate> = {}): IdeInstallCandidate {
  return {
    id: "vscode",
    label: "VS Code",
    cli: "code",
    cliPath: "/usr/bin/code",
    confidence: "current-terminal",
    targetVersion: "1.0.5",
    needsInstall: true,
    reason: "missing",
    ...overrides,
  };
}

function createCommandContext(): ExtensionCommandContext {
  return {
    cwd: "/repo",
    hasUI: true,
    ui: {
      notify: () => {},
      select: () => Promise.resolve(undefined),
      pasteToEditor: () => {},
      setWidget: () => {},
      setStatus: () => {},
    },
  } as unknown as ExtensionCommandContext;
}
