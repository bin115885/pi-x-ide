// ABOUTME: Hosts the local authenticated WebSocket server used by IDE extensions and sidecars.
// ABOUTME: Sends JSON-RPC selection notifications while isolating individual socket failures.
import { createServer, type Server } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import {
  AUTH_HEADER,
  PROTOCOL_VERSION,
  type EditorSelectionSnapshot,
  type IdeSource,
  type InitializeResult,
} from "./protocol.js";
import { isJsonRpcRequest } from "./jsonrpc-guard.js";
import { logExtensionError } from "./errors.js";
import { decodeRawData } from "./ws.js";
import { isPathInsideOrEqual, normalizePath } from "./paths.js";

export class IdeWebSocketServer {
  private httpServer?: Server;
  private wss?: WebSocketServer;
  private readonly sockets = new Set<WebSocket>();

  private readonly terminalSessions = new Map<WebSocket, string>();
  private readonly terminalProcessIds = new Map<WebSocket, number>();
  private readonly workspaceFolders = new Map<WebSocket, string>();
  constructor(
    private readonly authToken: string,
    private readonly serverInfo: { name: string; version?: string; ide?: IdeSource },
    private readonly getInitialSelection?: () => EditorSelectionSnapshot | undefined,
  ) {}

  get port(): number {
    const address = this.httpServer?.address();
    if (!address || typeof address === "string") return 0;
    return address.port;
  }

  get clientCount(): number {
    return this.openSockets.length;
  }

  async start(): Promise<number> {
    this.httpServer = createServer();
    this.wss = new WebSocketServer({
      server: this.httpServer,
      verifyClient: ({ req }, done) => {
        const header = req.headers[AUTH_HEADER];
        const token = Array.isArray(header) ? header[0] : header;
        done(token === this.authToken, token === this.authToken ? undefined : 401, "Unauthorized");
      },
    });

    this.wss.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => {
        this.sockets.delete(socket);
        this.terminalSessions.delete(socket);
        this.terminalProcessIds.delete(socket);
        this.workspaceFolders.delete(socket);
      });
      socket.on("error", () => {
        this.sockets.delete(socket);
        this.terminalSessions.delete(socket);
        this.terminalProcessIds.delete(socket);
        this.workspaceFolders.delete(socket);
      });
      socket.on("message", (raw) => {
        try {
          this.handleMessage(socket, decodeRawData(raw));
        } catch (error) {
          logExtensionError("IDE WebSocket server message", error);
          this.sockets.delete(socket);
          socket.close();
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once("error", reject);
      this.httpServer!.listen(0, "127.0.0.1", () => {
        this.httpServer!.off("error", reject);
        resolve();
      });
    });

    return this.port;
  }

  broadcast(value: unknown): void {
    let text: string;
    try {
      text = JSON.stringify(value);
    } catch (error) {
      logExtensionError("IDE WebSocket server broadcast serialization", error);
      return;
    }

    for (const socket of this.openSockets) this.sendText(socket, text, "broadcast");
  }

  sendToFirstClient(value: unknown): boolean {
    const [socket] = this.openSockets;
    if (!socket) return false;
    let text: string;
    try {
      text = JSON.stringify(value);
    } catch (error) {
      logExtensionError("IDE WebSocket server send serialization", error);
      return false;
    }
    return this.sendText(socket, text, "targeted send");
  }

  broadcastSelection(snapshot?: EditorSelectionSnapshot): void {
    const ide = this.serverInfo.ide ?? "vscode";
    for (const socket of this.openSockets) this.sendSelection(socket, snapshot, ide);
  }

  sendToTerminalSession(
    terminal: string | number,
    value: unknown,
    filePath: string,
    workspaceFolder?: string,
  ): boolean {
    const sessions = typeof terminal === "string" ? this.terminalSessions : this.terminalProcessIds;
    const sockets = this.openSockets.filter((client) => sessions.get(client) === terminal);
    const socket = sockets.length === 1 ? sockets[0] : undefined;
    return socket && this.matchesWorkspace(socket, { filePath, workspaceFolder })
      ? this.sendValue(socket, value, "terminal send")
      : false;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.close();
    this.sockets.clear();
    this.terminalSessions.clear();
    this.terminalProcessIds.clear();
    this.workspaceFolders.clear();
    await Promise.all([
      new Promise<void>((resolve) => this.wss?.close(() => resolve()) ?? resolve()),
      new Promise<void>((resolve) => this.httpServer?.close(() => resolve()) ?? resolve()),
    ]);
  }

  private handleMessage(socket: WebSocket, text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return;
    }

    if (!isJsonRpcRequest(parsed)) return;
    if (parsed.method !== "initialize") return;

    const terminalSessionId =
      parsed.params && typeof parsed.params === "object" && "terminalSessionId" in parsed.params
        ? parsed.params.terminalSessionId
        : undefined;
    if (typeof terminalSessionId === "string" && terminalSessionId) {
      this.terminalSessions.set(socket, terminalSessionId);
    }
    const parentProcessId =
      parsed.params && typeof parsed.params === "object" && "parentProcessId" in parsed.params
        ? parsed.params.parentProcessId
        : undefined;
    const platform =
      parsed.params && typeof parsed.params === "object" && "platform" in parsed.params
        ? parsed.params.platform
        : undefined;
    if (
      platform === process.platform &&
      typeof parentProcessId === "number" &&
      Number.isSafeInteger(parentProcessId) &&
      parentProcessId > 1
    ) {
      this.terminalProcessIds.set(socket, parentProcessId);
    }
    const workspaceFolder =
      parsed.params && typeof parsed.params === "object" && "workspaceFolder" in parsed.params
        ? parsed.params.workspaceFolder
        : undefined;
    if (typeof workspaceFolder === "string" && workspaceFolder) {
      this.workspaceFolders.set(socket, normalizePath(workspaceFolder));
    }
    const ide = this.serverInfo.ide ?? "vscode";
    const result: InitializeResult = {
      protocolVersion: PROTOCOL_VERSION,
      server: {
        name: this.serverInfo.name,
        version: this.serverInfo.version,
        ide,
      },
    };

    this.sendValue(socket, { jsonrpc: "2.0", id: parsed.id, result }, "initialize response");

    this.sendSelection(socket, this.getInitialSelection?.(), ide);
  }

  private matchesWorkspace(socket: WebSocket, snapshot: { filePath: string; workspaceFolder?: string }): boolean {
    const workspaceFolder = snapshot.workspaceFolder;
    return (
      !!workspaceFolder &&
      this.workspaceFolders.get(socket) === normalizePath(workspaceFolder) &&
      isPathInsideOrEqual(workspaceFolder, snapshot.filePath)
    );
  }

  private sendSelection(socket: WebSocket, snapshot: EditorSelectionSnapshot | undefined, ide: IdeSource): void {
    const selected = snapshot && (ide !== "vscode" || this.matchesWorkspace(socket, snapshot)) ? snapshot : undefined;
    this.sendValue(
      socket,
      {
        jsonrpc: "2.0",
        method: selected ? "selection_changed" : "selection_cleared",
        params: selected
          ? { ...selected, receivedAt: Date.now() }
          : { source: ide, reason: "no-active-editor", receivedAt: Date.now() },
      },
      "selection",
    );
  }

  private sendValue(socket: WebSocket, value: unknown, label: string): boolean {
    let text: string;
    try {
      text = JSON.stringify(value);
    } catch (error) {
      logExtensionError(`IDE WebSocket server ${label} serialization`, error);
      return false;
    }
    return this.sendText(socket, text, label);
  }

  private sendText(socket: WebSocket, text: string, label: string): boolean {
    try {
      socket.send(text, (error) => {
        if (!error) return;
        logExtensionError(`IDE WebSocket server ${label}`, error);
        this.sockets.delete(socket);
        socket.close();
      });
      return true;
    } catch (error) {
      logExtensionError(`IDE WebSocket server ${label}`, error);
      this.sockets.delete(socket);
      socket.close();
      return false;
    }
  }

  private get openSockets(): WebSocket[] {
    return [...this.sockets].filter((socket) => socket.readyState === WebSocket.OPEN);
  }
}
