// ABOUTME: Tests WebSocket initialize and authentication behavior for the JetBrains plugin server.
// ABOUTME: Verifies Pi receives initialize plus initial selection-cleared notifications only when authorized.
package com.balaenis.pixide.server

import com.balaenis.pixide.EXT_CONFIG_NAME
import com.balaenis.pixide.protocol.AUTH_HEADER
import com.balaenis.pixide.protocol.EditorSelectionSnapshot
import com.google.gson.JsonParser
import java.io.IOException
import java.net.URI
import java.net.http.HttpClient
import java.net.http.WebSocket
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionStage
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import org.java_websocket.server.WebSocketServer as JavaWebSocketServer
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class PiXIdeWebSocketServerTest {
    @Test
    fun authorizedClientReceivesInitializeResponseAndInitialSelectionCleared() {
        val server = PiXIdeWebSocketServer(
            authToken = "token",
            pluginVersion = "1.13.1",
            getInitialSelection = { null },
        )
        try {
            val port = server.start()
            val listener = CollectingListener()
            val socket = connect(port, "token", listener)
            socket.sendText(initializeRequest(), true).get(5, TimeUnit.SECONDS)

            val initialize = listener.nextMessage()
            val initial = listener.nextMessage()
            assertNotNull(initialize)
            assertNotNull(initial)

            val response = JsonParser.parseString(initialize).asJsonObject
            assertEquals("2.0", response.get("jsonrpc").asString)
            assertEquals(1, response.get("id").asInt)
            assertEquals("jetbrains", response.getAsJsonObject("result").getAsJsonObject("server").get("ide").asString)

            val notification = JsonParser.parseString(initial).asJsonObject
            assertEquals("selection_cleared", notification.get("method").asString)
            assertEquals("jetbrains", notification.getAsJsonObject("params").get("source").asString)
            assertTrue(server.clientCount >= 1)

            socket.sendClose(WebSocket.NORMAL_CLOSURE, "done").get(5, TimeUnit.SECONDS)
            listener.closed.get(5, TimeUnit.SECONDS)
            assertEquals(0, server.clientCount)
        } finally {
            server.stop()
        }
    }

    @Test
    fun sendsAttachOnlyToRequestedTerminalSession() {
        val server = PiXIdeWebSocketServer(
            authToken = "token",
            pluginVersion = "1.19.3",
            getInitialSelection = { null },
        )
        try {
            val port = server.start()
            val firstListener = CollectingListener()
            val secondListener = CollectingListener()
            val first = connect(port, "token", firstListener)
            val second = connect(port, "token", secondListener)
            first.sendText(initializeRequest("first"), true).get(5, TimeUnit.SECONDS)
            second.sendText(initializeRequest("second"), true).get(5, TimeUnit.SECONDS)
            repeat(2) {
                assertNotNull(firstListener.nextMessage())
                assertNotNull(secondListener.nextMessage())
            }

            val snapshot = EditorSelectionSnapshot(
                filePath = "/repo/src/main.ts",
                workspaceFolder = "/repo",
                ranges = emptyList(),
            )
            assertTrue(server.sendAtMentioned(snapshot, "@src/main.ts", "second"))
            assertEquals(null, firstListener.messages.poll(300, TimeUnit.MILLISECONDS))
            val received = JsonParser.parseString(assertNotNull(secondListener.nextMessage())).asJsonObject
            assertEquals("at_mentioned", received.get("method").asString)
            assertEquals(false, server.sendAtMentioned(snapshot, "@src/main.ts", "missing"))

            first.sendClose(WebSocket.NORMAL_CLOSURE, "done").get(5, TimeUnit.SECONDS)
            second.sendClose(WebSocket.NORMAL_CLOSURE, "done").get(5, TimeUnit.SECONDS)
        } finally {
            server.stop()
        }
    }

    @Test
    fun closingDuplicateConnectionKeepsOriginalTerminalRoute() {
        val server = PiXIdeWebSocketServer(
            authToken = "token",
            pluginVersion = "1.19.10",
            getInitialSelection = { null },
        )
        try {
            val port = server.start()
            val originalListener = CollectingListener()
            val original = connect(port, "token", originalListener)
            original.sendText(initializeRequest("terminal"), true).get(5, TimeUnit.SECONDS)
            repeat(2) { assertNotNull(originalListener.nextMessage()) }

            val duplicateListener = CollectingListener()
            val duplicate = connect(port, "token", duplicateListener)
            duplicate.sendText(initializeRequest("terminal"), true).get(5, TimeUnit.SECONDS)
            repeat(2) { assertNotNull(duplicateListener.nextMessage()) }

            val snapshot = EditorSelectionSnapshot(
                filePath = "/repo/src/main.ts",
                workspaceFolder = "/repo",
                ranges = emptyList(),
            )
            assertTrue(server.sendAtMentioned(snapshot, "@src/main.ts", "terminal"))
            val firstReceived = JsonParser.parseString(assertNotNull(originalListener.nextMessage())).asJsonObject
            assertEquals("at_mentioned", firstReceived.get("method").asString)
            assertEquals(null, duplicateListener.messages.poll(300, TimeUnit.MILLISECONDS))

            duplicate.sendClose(WebSocket.NORMAL_CLOSURE, "done").get(5, TimeUnit.SECONDS)
            duplicateListener.closed.get(5, TimeUnit.SECONDS)
            assertEquals(1, server.clientCount)

            assertTrue(server.sendAtMentioned(snapshot, "@src/main.ts", "terminal"))
            val remainingReceived = JsonParser.parseString(assertNotNull(originalListener.nextMessage())).asJsonObject
            assertEquals("at_mentioned", remainingReceived.get("method").asString)

            original.sendClose(WebSocket.NORMAL_CLOSURE, "done").get(5, TimeUnit.SECONDS)
        } finally {
            server.stop()
        }
    }

    @Test
    fun connectionErrorClosesSocketAndAllowsTerminalToReconnect() {
        val server = PiXIdeWebSocketServer(
            authToken = "token",
            pluginVersion = "1.19.8",
            getInitialSelection = { null },
        )
        try {
            val port = server.start()
            val listener = CollectingListener()
            val socket = connect(port, "token", listener)
            socket.sendText(initializeRequest("terminal"), true).get(5, TimeUnit.SECONDS)
            repeat(2) { assertNotNull(listener.nextMessage()) }

            val delegateField = PiXIdeWebSocketServer::class.java.getDeclaredField("delegate")
            delegateField.isAccessible = true
            val delegate = delegateField.get(server) as JavaWebSocketServer
            delegate.onError(delegate.connections.single(), IOException("transient"))
            listener.closed.get(5, TimeUnit.SECONDS)
            assertEquals(0, server.clientCount)

            val replacementListener = CollectingListener()
            val replacement = connect(port, "token", replacementListener)
            replacement.sendText(initializeRequest("terminal"), true).get(5, TimeUnit.SECONDS)
            repeat(2) { assertNotNull(replacementListener.nextMessage()) }

            val snapshot = EditorSelectionSnapshot(
                filePath = "/repo/src/main.ts",
                workspaceFolder = "/repo",
                ranges = emptyList(),
            )
            assertTrue(server.sendAtMentioned(snapshot, "@src/main.ts", "terminal"))
            val received = JsonParser.parseString(assertNotNull(replacementListener.nextMessage())).asJsonObject
            assertEquals("at_mentioned", received.get("method").asString)

            replacement.sendClose(WebSocket.NORMAL_CLOSURE, "done").get(5, TimeUnit.SECONDS)
        } finally {
            server.stop()
        }
    }

    @Test
    fun unauthorizedClientReceivesNoInitializeResponse() {
        val server = PiXIdeWebSocketServer(
            authToken = "token",
            pluginVersion = "1.13.1",
            getInitialSelection = { null },
        )
        try {
            val port = server.start()
            val listener = CollectingListener()
            val result = runCatching { connect(port, "wrong", listener) }
            if (result.isSuccess) {
                result.getOrThrow().sendText(initializeRequest(), true).get(5, TimeUnit.SECONDS)
                assertEquals(null, listener.messages.poll(500, TimeUnit.MILLISECONDS))
            }
            assertEquals(0, server.clientCount)
        } finally {
            server.stop()
        }
    }

    private fun connect(port: Int, token: String, listener: CollectingListener): WebSocket =
        HttpClient.newHttpClient()
            .newWebSocketBuilder()
            .header(AUTH_HEADER, token)
            .buildAsync(URI.create("ws://127.0.0.1:$port"), listener)
            .get(5, TimeUnit.SECONDS)

    private fun initializeRequest(terminalSessionId: String? = null): String {
        val terminalSession = terminalSessionId?.let { ",\"terminalSessionId\":\"$it\"" }.orEmpty()
        return """{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"client":{"name":"$EXT_CONFIG_NAME","version":"test"},"cwd":"/repo"$terminalSession}}"""
    }
    class CollectingListener : WebSocket.Listener {
        val messages = LinkedBlockingQueue<String>()
        val closed = CompletableFuture<Int>()

        override fun onOpen(webSocket: WebSocket) {
            webSocket.request(1)
        }

        override fun onText(webSocket: WebSocket, data: CharSequence, last: Boolean): CompletableFuture<*> {
            messages.offer(data.toString())
            webSocket.request(1)
            return CompletableFuture.completedFuture(null)
        }

        override fun onClose(
            webSocket: WebSocket,
            statusCode: Int,
            reason: String,
        ): CompletionStage<*>? {
            closed.complete(statusCode)
            return null
        }

        fun nextMessage(): String? = messages.poll(5, TimeUnit.SECONDS)
    }
}
