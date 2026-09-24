// ABOUTME: Starts the VS Code-side pi-x-ide WebSocket bridge and lock-file lifecycle.
// ABOUTME: Publishes editor selections to Pi while containing extension-host callback failures.
import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { TERMINAL_SESSION_ENV, type EditorSelectionSnapshot } from "@shared/protocol";
import { formatRangeMention } from "@shared/format";
import { errorMessage, logExtensionError, safeRun, safeRunAsync } from "@shared/errors";
import { registerDiagnosticQuickFixes } from "./diagnostics";
import {
  createAuthToken,
  createLockFile,
  createLockFilePath,
  refreshLockFile,
  removeIdeLockFile,
  writeIdeLockFile,
} from "./lock-file";
import { IdeWebSocketServer } from "./server";
import { getActiveSelectionSnapshot } from "./selection";

const CONFIG_SECTION = "piXIde";
const USE_TMUX_CONFIG_KEY = "useTmux";

let server: IdeWebSocketServer | undefined;
let lockFilePath: string | undefined;
let lockFile = undefined as ReturnType<typeof createLockFile> | undefined;
let debounceTimer: NodeJS.Timeout | undefined;
let tmuxSessionCounter = 0;
const piTerminalSessions = new WeakMap<vscode.Terminal, string>();

function runVscode(scope: string, action: () => void): void {
  safeRun(`VS Code ${scope}`, action, (error) => reportVscodeError(scope, error));
}

async function runVscodeAsync(scope: string, action: () => Promise<void>): Promise<void> {
  await safeRunAsync(`VS Code ${scope}`, action, (error) => reportVscodeError(scope, error));
}

function reportVscodeError(scope: string, error: unknown): void {
  logExtensionError(`VS Code ${scope}`, error);
  void vscode.window.showWarningMessage(`Pi x IDE: ${scope} failed: ${errorMessage(error)}`);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  try {
    await activateExtension(context);
  } catch (error) {
    reportVscodeError("activate", error);
    await runVscodeAsync("cleanup after failed activate", cleanup);
  }
}

async function activateExtension(context: vscode.ExtensionContext): Promise<void> {
  const packageJson = context.extension.packageJSON as { version?: string };
  const authToken = createAuthToken();

  server = new IdeWebSocketServer(
    authToken,
    {
      name: "Pi x IDE VS Code",
      version: packageJson.version,
    },
    getActiveSelectionSnapshot,
  );

  const port = await server.start();
  lockFilePath = createLockFilePath(port);
  lockFile = createLockFile(port, authToken);
  await writeIdeLockFile(lockFilePath, lockFile);

  registerDiagnosticQuickFixes(context, () => server, selectedPiTarget);

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      scheduleSelectionBroadcast();
      if (editor) void runVscodeAsync("keep files left of Pi", moveFileGroupLeft);
    }),
    vscode.window.onDidChangeTextEditorSelection(() => scheduleSelectionBroadcast()),
    vscode.window.tabGroups.onDidChangeTabs(() => scheduleSelectionBroadcast()),
    vscode.window.tabGroups.onDidChangeTabGroups((event) => {
      if (event.opened.length || event.changed.some((group) => group.isActive)) {
        setTimeout(() => void runVscodeAsync("keep files left of Pi", moveFileGroupLeft), 0);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      refreshLock().catch((error: unknown) => handleRefreshLockError(error));
      scheduleSelectionBroadcast();
    }),
    vscode.commands.registerCommand(
      "pi-x-ide.attachSelection",
      () => void runVscodeAsync("attach selection", attachSelection),
    ),
    vscode.commands.registerCommand(
      "pi-x-ide.attachPath",
      (uri?: vscode.Uri, selected?: vscode.Uri[]) =>
        void runVscodeAsync("attach path", async () => {
          if (uri) await attachPaths(selected?.length ? selected : [uri]);
          else await attachSelection();
        }),
    ),
    vscode.commands.registerCommand("pi-x-ide.openPiTerminal", () =>
      runVscode("open Pi terminal", () => openPiTerminal(context)),
    ),
    { dispose: () => void runVscodeAsync("dispose", cleanup) },
  );

  scheduleSelectionBroadcast(0);
}

export async function deactivate(): Promise<void> {
  await runVscodeAsync("deactivate", cleanup);
}

async function cleanup(): Promise<void> {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = undefined;
  await removeIdeLockFile(lockFilePath);
  lockFilePath = undefined;
  await server?.stop();
  server = undefined;
}

async function refreshLock(): Promise<void> {
  if (!lockFilePath || !lockFile) return;
  lockFile = refreshLockFile(lockFile);
  await writeIdeLockFile(lockFilePath, lockFile);
}

function handleRefreshLockError(error: unknown): void {
  logExtensionError("VS Code refresh lock file", error);
  const suffix = error instanceof Error ? `: ${error.message}` : "";
  void vscode.window.showWarningMessage(`Pi x IDE: failed to refresh lock file${suffix}`);
}

function scheduleSelectionBroadcast(delayMs = 150): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = undefined;
    runVscode("broadcast selection", () => broadcastSelection());
  }, delayMs);
}

function broadcastSelection(): void {
  const snapshot = getActiveSelectionSnapshot();
  if (!server) return;
  server.broadcastSelection(snapshot);
}

async function attachSelection(): Promise<void> {
  const snapshot = getActiveSelectionSnapshot();
  if (!snapshot) {
    vscode.window.showWarningMessage("Pi x IDE: no active file to attach.");
    return;
  }
  await attachSnapshots([snapshot]);
}

async function attachPaths(uris: vscode.Uri[]): Promise<void> {
  await attachSnapshots(
    uris
      .filter((uri) => uri.scheme === "file")
      .map((uri) => ({
        source: "vscode",
        filePath: uri.fsPath,
        workspaceFolder: vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath,
        ranges: [],
      })),
  );
}

async function selectedPiTarget(): Promise<{ terminal: vscode.Terminal; id: string | number } | undefined> {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) return undefined;
  const sessionId = piTerminalSessions.get(terminal);
  if (sessionId) return { terminal, id: sessionId };
  const processId = await terminal.processId;
  return processId && processId > 1 ? { terminal, id: processId } : undefined;
}

async function attachSnapshots(snapshots: EditorSelectionSnapshot[]): Promise<void> {
  const target = await selectedPiTarget();
  if (!target || !server) {
    vscode.window.showWarningMessage("Pi x IDE: select a connected Pi terminal first.");
    return;
  }
  if (
    !snapshots.length ||
    snapshots.some((snapshot) => !snapshot.workspaceFolder || snapshot.workspaceFolder !== snapshots[0].workspaceFolder)
  ) {
    vscode.window.showWarningMessage("Pi x IDE: select files from one VS Code workspace at a time.");
    return;
  }
  for (const snapshot of snapshots) {
    const rangeText = formatRangeMention(snapshot);
    if (
      !server.sendToTerminalSession(
        target.id,
        {
          jsonrpc: "2.0",
          method: "at_mentioned",
          params: { ...snapshot, rangeText, receivedAt: Date.now() },
        },
        snapshot.filePath,
        snapshot.workspaceFolder,
      )
    ) {
      vscode.window.showWarningMessage(
        `Pi x IDE: selected Pi terminal is disconnected or belongs to another workspace. Reference: ${rangeText}`,
      );
      return;
    }
    vscode.window.setStatusBarMessage(`Pi x IDE attached ${rangeText}`, 2500);
  }
  target.terminal.show(false);
}

const moveFileGroupLeft = async (): Promise<void> => {
  const activeTerminal = vscode.window.activeTerminal;
  if (!activeTerminal || !piTerminalSessions.has(activeTerminal)) return;
  const groups = vscode.window.tabGroups;
  const fileGroup = groups.activeTabGroup;
  if (!(fileGroup.activeTab?.input instanceof vscode.TabInputText)) return;
  const terminalGroup = groups.all.find(
    (group) => group.tabs.length > 0 && group.tabs.every((tab) => tab.input instanceof vscode.TabInputTerminal),
  );
  if (!terminalGroup) return;
  for (let i = 0; i < groups.all.length && fileGroup.viewColumn > terminalGroup.viewColumn; i++) {
    if (groups.activeTabGroup !== fileGroup) break;
    const column = fileGroup.viewColumn;
    await vscode.commands.executeCommand("workbench.action.moveActiveEditorGroupLeft");
    if (fileGroup.viewColumn >= column) break;
  }
};

function openPiTerminal(context: vscode.ExtensionContext): void {
  const useTmux = vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(USE_TMUX_CONFIG_KEY, false);
  const sessionId = randomUUID();
  const terminalGroup = vscode.window.tabGroups.all.find(
    (group) => group.tabs.length > 0 && group.tabs.every((tab) => tab.input instanceof vscode.TabInputTerminal),
  );
  const terminal = vscode.window.createTerminal({
    env: { [TERMINAL_SESSION_ENV]: sessionId },
    hideFromUser: true,
    iconPath: {
      light: vscode.Uri.file(context.asAbsolutePath("assets/icons/icon-light.png")),
      dark: vscode.Uri.file(context.asAbsolutePath("assets/icons/icon-dark.png")),
    },
    location: {
      viewColumn: terminalGroup?.viewColumn ?? vscode.ViewColumn.Beside,
      preserveFocus: false,
    },
  });

  piTerminalSessions.set(terminal, sessionId);
  terminal.sendText(useTmux ? buildTmuxPiCommand() : "pi");
  terminal.show(false);
}

function buildTmuxPiCommand(): string {
  tmuxSessionCounter += 1;
  const sessionName = `pi-${Date.now().toString(36)}-${tmuxSessionCounter.toString(36)}`;
  // Run `pi` through a login + interactive shell so shell init files
  // (e.g. ~/.zshrc, ~/.zprofile) are loaded just like a normal terminal.
  // tmux exec's the command directly otherwise, skipping shell startup.
  const piCommand = '"${SHELL:-/bin/sh}" -lic pi';
  return `tmux new-session -d -s ${sessionName} ${piCommand} \\; set-option -t ${sessionName} destroy-unattached on \\; attach-session -t ${sessionName}`;
}
