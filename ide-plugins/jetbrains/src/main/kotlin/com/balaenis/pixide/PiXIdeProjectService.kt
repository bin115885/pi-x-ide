// ABOUTME: Orchestrates JetBrains project lifecycle for pi-x-ide selection integration.
// ABOUTME: Owns WebSocket, lock-file, editor tracking, attach handling, status, and embedded Pi terminal focus.
package com.balaenis.pixide

import com.balaenis.pixide.editor.PiXIdeEditorTracker
import com.balaenis.pixide.editor.PiXIdeSnapshotBuilder
import com.balaenis.pixide.editor.PiXIdeWorkspace
import com.balaenis.pixide.lock.PiXIdeLockFileManager
import com.balaenis.pixide.protocol.EditorSelectionSnapshot
import com.balaenis.pixide.protocol.SelectionClearedParams
import com.balaenis.pixide.protocol.TERMINAL_SESSION_ENV
import com.balaenis.pixide.server.PiXIdeWebSocketServer
import com.balaenis.pixide.ui.PiXIdeStatusBarWidgetFactory
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.IdeFocusManager
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.openapi.wm.WindowManager
import com.intellij.terminal.frontend.toolwindow.TerminalToolWindowTab
import com.intellij.terminal.frontend.toolwindow.TerminalToolWindowTabsManager
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import org.jetbrains.plugins.terminal.session.TerminalStartupOptions
import java.util.Properties
import java.util.concurrent.atomic.AtomicBoolean

@OptIn(ExperimentalCoroutinesApi::class)
internal fun terminalSessionId(startupOptions: Deferred<TerminalStartupOptions>): String? {
    if (!startupOptions.isCompleted || startupOptions.isCancelled) return null
    return startupOptions.getCompleted().envVariables[TERMINAL_SESSION_ENV]
}

class PiXIdeProjectService(
    private val project: Project,
) : Disposable {
    private val lockFileManager = PiXIdeLockFileManager()
    private val started = AtomicBoolean(false)
    private var server: PiXIdeWebSocketServer? = null
    private var editorTracker: PiXIdeEditorTracker? = null

    @Volatile
    private var latestSnapshot: EditorSelectionSnapshot? = null

    @Volatile
    private var status: ServiceStatus = ServiceStatus.Idle

    fun start() {
        if (!started.compareAndSet(false, true)) return
        try {
            val token = PiXIdeLockFileManager.createAuthToken()
            val webSocketServer = PiXIdeWebSocketServer(
                authToken = token,
                pluginVersion = pluginVersion(),
                getInitialSelection = { currentSnapshot() },
                onClientCountChanged = { updateStatusBar() },
            )
            val port = webSocketServer.start()
            server = webSocketServer
            lockFileManager.write(port, token, PiXIdeWorkspace.workspaceFolders(project))
            status = ServiceStatus.Running

            editorTracker = PiXIdeEditorTracker(project, this).also { it.start(this) }
            publishCurrentSelection()
            updateStatusBar()
        } catch (error: Throwable) {
            LOG.warn("Failed to start Pi x IDE JetBrains integration", error)
            status = ServiceStatus.Failed(error.message ?: error.javaClass.simpleName)
            started.set(false)
            runCatching { lockFileManager.cleanup() }
            runCatching { server?.stop() }
            server = null
            updateStatusBar()
        }
    }

    fun publishCurrentSelection() = publishSelection(currentSnapshot())

    fun publishSelection(snapshot: EditorSelectionSnapshot?) {
        if (snapshot != null) {
            latestSnapshot = snapshot
            server?.broadcastNotification("selection_changed", snapshot.copy(receivedAt = System.currentTimeMillis()))
        } else {
            latestSnapshot = null
            server?.broadcastNotification("selection_cleared", SelectionClearedParams(receivedAt = System.currentTimeMillis()))
        }
        updateStatusBar()
    }

    fun refreshWorkspaceFolders() {
        runCatching { lockFileManager.refresh(PiXIdeWorkspace.workspaceFolders(project)) }
            .onFailure { LOG.warn("Failed to refresh Pi x IDE lock file", it) }
    }

    fun attachCurrentSelection(): AttachResult = attachSelection(currentSnapshot())

    fun attachSelection(snapshot: EditorSelectionSnapshot?): AttachResult {
        snapshot ?: return AttachResult.NoActiveFile
        val terminal = activePiTerminal() ?: return AttachResult.NoActivePiTerminal
        latestSnapshot = snapshot
        val rangeText = formatRangeMention(snapshot)
        val sent = server?.sendAtMentioned(snapshot, rangeText, terminal.sessionId) == true
        if (sent) focusPiTerminal(terminal.tab)
        updateStatusBar()
        return if (sent) AttachResult.Attached(rangeText) else AttachResult.TargetNotConnected(rangeText)
    }

    fun clientCount(): Int = server?.clientCount ?: 0

    fun statusText(): String {
        latestSnapshot?.let { return "⧉ Pi x IDE ${formatRangeMention(it)}" }
        val clients = clientCount()
        if (clients > 0) return "⧉ Pi x IDE $clients Pi"
        return when (val current = status) {
            ServiceStatus.Idle -> "⧉ Pi x IDE idle"
            ServiceStatus.Running -> "⧉ Pi x IDE waiting"
            is ServiceStatus.Failed -> "⧉ Pi x IDE failed"
        }
    }

    fun tooltipText(): String = when (val current = status) {
        ServiceStatus.Idle -> "Pi x IDE is idle"
        ServiceStatus.Running -> "Pi x IDE JetBrains server is listening on port ${server?.port ?: 0}"
        is ServiceStatus.Failed -> "Pi x IDE failed to start: ${current.message}"
    }

    fun latestSnapshot(): EditorSelectionSnapshot? = latestSnapshot

    fun formatRangeMention(snapshot: EditorSelectionSnapshot): String {
        val relative = PiXIdeWorkspace.relativePath(snapshot.filePath, snapshot.workspaceFolder)
        val first = snapshot.ranges.firstOrNull() ?: return "@$relative"
        val startLine = first.selection.start.line + 1
        val endLine = first.selection.end.line + 1
        val lineSpan = if (startLine == endLine) "L$startLine" else "L$startLine-L$endLine"
        return "@$relative#$lineSpan"
    }

    override fun dispose() {
        editorTracker?.stop()
        editorTracker = null
        runCatching { lockFileManager.cleanup() }
        runCatching { server?.stop() }
        server = null
        latestSnapshot = null
        status = ServiceStatus.Idle
        started.set(false)
        updateStatusBar()
    }

    private fun currentSnapshot(): EditorSelectionSnapshot? =
        runCatching { PiXIdeSnapshotBuilder.activeSnapshot(project) }
            .onFailure { LOG.warn("Failed to build Pi x IDE selection snapshot", it) }
            .getOrNull()

    private fun activePiTerminal(): PiTerminal? {
        val tabs = TerminalToolWindowTabsManager.getInstance(project).tabs
        val selectedContent = ToolWindowManager.getInstance(project)
            .getToolWindow("Terminal")
            ?.contentManager
            ?.selectedContent
            ?: return null
        val tab = tabs.firstOrNull { it.content === selectedContent } ?: return null
        val sessionId = terminalSessionId(tab.view.startupOptionsDeferred) ?: return null
        return PiTerminal(tab, sessionId)
    }

    private fun focusPiTerminal(tab: TerminalToolWindowTab) {
        ApplicationManager.getApplication().invokeLater(
            {
                if (project.isDisposed) return@invokeLater
                if (tab !in TerminalToolWindowTabsManager.getInstance(project).tabs) return@invokeLater
                val toolWindow = ToolWindowManager.getInstance(project)
                    .getToolWindow("Terminal")
                    ?: return@invokeLater
                toolWindow.activate(
                    {
                        toolWindow.contentManager.setSelectedContent(tab.content, true)
                        IdeFocusManager.getInstance(project)
                            .requestFocusInProject(tab.view.preferredFocusableComponent, project)
                    },
                    true,
                )
            },
            ModalityState.any(),
        )
    }

    private fun updateStatusBar() {
        val application = ApplicationManager.getApplication()
        application.invokeLater(
            {
                if (!project.isDisposed) {
                    WindowManager.getInstance().getStatusBar(project)?.updateWidget(PiXIdeStatusBarWidgetFactory.WIDGET_ID)
                }
            },
            ModalityState.any(),
        )
    }

    private fun pluginVersion(): String =
        runCatching {
            val properties = Properties()
            PiXIdeProjectService::class.java.classLoader
                .getResourceAsStream("pi-x-ide.properties")
                ?.use { properties.load(it) }
            properties.getProperty("plugin.version")?.takeIf { it.isNotBlank() } ?: "dev"
        }.onFailure { LOG.warn("Failed to read Pi x IDE plugin version resource", it) }
            .getOrDefault("dev")

    sealed class AttachResult {
        data class Attached(val rangeText: String) : AttachResult()
        data class TargetNotConnected(val rangeText: String) : AttachResult()
        object NoActiveFile : AttachResult()
        object NoActivePiTerminal : AttachResult()
    }

    private data class PiTerminal(
        val tab: TerminalToolWindowTab,
        val sessionId: String,
    )

    private sealed class ServiceStatus {
        object Idle : ServiceStatus()
        object Running : ServiceStatus()
        data class Failed(val message: String) : ServiceStatus()
    }

    companion object {
        private val LOG = Logger.getInstance(PiXIdeProjectService::class.java)

        fun getInstance(project: Project): PiXIdeProjectService = project.service()
    }
}
