// ABOUTME: Verifies Pi terminal session IDs are recovered from JetBrains startup metadata.
// ABOUTME: Covers project-service recreation without relying on an in-memory terminal registry.
package com.balaenis.pixide

import com.balaenis.pixide.protocol.TERMINAL_SESSION_ENV
import kotlinx.coroutines.CompletableDeferred
import org.jetbrains.plugins.terminal.session.TerminalStartupOptions
import org.jetbrains.plugins.terminal.startup.TerminalProcessType
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class PiXIdeProjectServiceTest {
    @Test
    fun recoversSessionIdFromCompletedTerminalStartupOptions() {
        val startupOptions = startupOptions(mapOf(TERMINAL_SESSION_ENV to "session-id"))

        assertEquals("session-id", terminalSessionId(CompletableDeferred(startupOptions)))
    }

    @Test
    fun ignoresTerminalBeforeStartupOptionsAreAvailable() {
        assertNull(terminalSessionId(CompletableDeferred<TerminalStartupOptions>()))
    }

    private fun startupOptions(env: Map<String, String>) = object : TerminalStartupOptions {
        override val shellCommand = emptyList<String>()
        override val workingDirectory = "/repo"
        override val envVariables = env
        override val processType = TerminalProcessType.SHELL
        override val pid = 1L
    }
}
