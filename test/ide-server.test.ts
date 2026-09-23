import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { IdeWebSocketServer } from "../src/shared/ide-server.js";
import { AUTH_HEADER } from "../src/shared/protocol.js";
import { decodeRawData } from "../src/shared/ws.js";

void test("sends targeted notifications to only one connected client", async () => {
  const server = new IdeWebSocketServer("token", { name: "Test IDE", ide: "vscode" });
  const port = await server.start();
  const clients = await Promise.all([connectClient(port), connectClient(port)]);
  const received = clients.map((client) => collectMessages(client));

  try {
    assert.equal(server.clientCount, 2);

    assert.equal(server.sendToFirstClient({ jsonrpc: "2.0", method: "targeted" }), true);
    await waitFor(() => received[0].length + received[1].length === 1);

    assert.equal(received[0].length + received[1].length, 1);
  } finally {
    for (const client of clients) client.close();
    await server.stop();
  }
});

void test("routes attaches only to the selected terminal session", async () => {
  const server = new IdeWebSocketServer("token", { name: "Test IDE", ide: "vscode" });
  const port = await server.start();
  const clients = await Promise.all([connectClient(port), connectClient(port)]);
  const received = clients.map(collectMessages);
  try {
    clients.forEach((client, index) =>
      client.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: index,
          method: "initialize",
          params: { terminalSessionId: `session-${index}`, workspaceFolder: `/repo/${index}` },
        }),
      ),
    );
    await waitFor(() => received.every((messages) => messages.length >= 2));
    received.forEach((messages) => messages.splice(0));

    assert.equal(server.sendToTerminalSession("missing", { method: "at_mentioned" }, "/repo/1/a.ts", "/repo/1"), false);
    assert.equal(
      server.sendToTerminalSession("session-1", { method: "at_mentioned" }, "/repo/0/a.ts", "/repo/0"),
      false,
    );
    assert.equal(
      server.sendToTerminalSession("session-1", { method: "at_mentioned" }, "/repo/0/a.ts", "/repo/1"),
      false,
    );
    assert.equal(
      server.sendToTerminalSession("session-1", { method: "at_mentioned" }, "/repo/1/sub/a.ts", "/repo/1/sub"),
      false,
    );
    assert.equal(
      server.sendToTerminalSession("session-1", { method: "at_mentioned" }, "/repo/1/a.ts", "/repo/1"),
      true,
    );
    await waitFor(() => received[1].length === 1);
    assert.equal(received[0].length, 0);
    assert.equal(JSON.parse(received[1][0]).method, "at_mentioned");

    const duplicate = await connectClient(port);
    try {
      const duplicateMessages = collectMessages(duplicate);
      duplicate.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "initialize",
          params: { terminalSessionId: "session-1", workspaceFolder: "/repo/1" },
        }),
      );
      await waitFor(() => duplicateMessages.length >= 2);
      assert.equal(
        server.sendToTerminalSession("session-1", { method: "at_mentioned" }, "/repo/1/a.ts", "/repo/1"),
        false,
      );
      assert.equal(received[1].length, 1);
    } finally {
      duplicate.close();
    }
  } finally {
    for (const client of clients) client.close();
    await server.stop();
  }
});

void test("routes manual Pi by terminal shell PID without sending to other sessions", async () => {
  const server = new IdeWebSocketServer("token", { name: "Test IDE", ide: "vscode" });
  const port = await server.start();
  const clients = await Promise.all([connectClient(port), connectClient(port)]);
  const received = clients.map(collectMessages);
  try {
    clients.forEach((client, index) =>
      client.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: index,
          method: "initialize",
          params: { parentProcessId: 100 + index, platform: process.platform, workspaceFolder: `/repo/${index}` },
        }),
      ),
    );
    await waitFor(() => received.every((messages) => messages.length >= 2));
    received.forEach((messages) => messages.splice(0));

    assert.equal(server.sendToTerminalSession(100, { method: "at_mentioned" }, "/repo/0/a.ts", "/repo/0"), true);
    await waitFor(() => received[0].length === 1);
    assert.equal(received[1].length, 0);
    assert.equal(server.sendToTerminalSession(999, { method: "at_mentioned" }, "/repo/0/a.ts", "/repo/0"), false);

    const duplicate = await connectClient(port);
    try {
      const duplicateMessages = collectMessages(duplicate);
      duplicate.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "initialize",
          params: { parentProcessId: 100, platform: process.platform, workspaceFolder: "/repo/0" },
        }),
      );
      await waitFor(() => duplicateMessages.length >= 2);
      assert.equal(server.sendToTerminalSession(100, { method: "at_mentioned" }, "/repo/0/a.ts", "/repo/0"), false);
      assert.equal(received[0].length, 1);
    } finally {
      duplicate.close();
    }
  } finally {
    for (const client of clients) client.close();
    await server.stop();
  }
});

void test("isolates live and initial selection between VS Code workspaces", async () => {
  const initial = { source: "vscode" as const, filePath: "/repo/a/file.ts", workspaceFolder: "/repo/a", ranges: [] };
  const server = new IdeWebSocketServer("token", { name: "Test IDE", ide: "vscode" }, () => initial);
  const port = await server.start();
  const clients = await Promise.all([connectClient(port), connectClient(port)]);
  const received = clients.map(collectMessages);
  try {
    clients.forEach((client, index) =>
      client.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: index,
          method: "initialize",
          params: { workspaceFolder: index ? "/repo/b" : "/repo/a" },
        }),
      ),
    );
    await waitFor(() => received.every((messages) => messages.length >= 2));
    assert.equal(JSON.parse(received[0][1]).method, "selection_changed");
    assert.equal(JSON.parse(received[1][1]).method, "selection_cleared");
    received.forEach((messages) => messages.splice(0));

    server.broadcastSelection({ ...initial, filePath: "/repo/b/other.ts", workspaceFolder: "/repo/b" });
    await waitFor(() => received.every((messages) => messages.length === 1));
    assert.equal(JSON.parse(received[0][0]).method, "selection_cleared");
    assert.equal(JSON.parse(received[1][0]).method, "selection_changed");
    assert.equal(JSON.parse(received[1][0]).params.filePath, "/repo/b/other.ts");
  } finally {
    for (const client of clients) client.close();
    await server.stop();
  }
});

async function connectClient(port: number): Promise<WebSocket> {
  const client = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { [AUTH_HEADER]: "token" } });
  await new Promise<void>((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  return client;
}

function collectMessages(client: WebSocket): string[] {
  const messages: string[] = [];
  client.on("message", (raw) => messages.push(decodeRawData(raw)));
  return messages;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition was not met before timeout");
}
