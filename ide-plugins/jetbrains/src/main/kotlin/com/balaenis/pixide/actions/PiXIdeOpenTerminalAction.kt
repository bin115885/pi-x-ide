// ABOUTME: Opens a JetBrains embedded terminal in the project directory and runs Pi.
// ABOUTME: Provides the IDE-side entry point for starting a Pi session from JetBrains.
package com.balaenis.pixide.actions

import com.balaenis.pixide.PiXIdeProjectService
import com.balaenis.pixide.protocol.TERMINAL_SESSION_ENV
import com.balaenis.pixide.util.terminalCommandForProject
import com.balaenis.pixide.util.terminalWorkingDirectoryForProject
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.terminal.frontend.toolwindow.TerminalToolWindowTabsManager
import java.util.UUID

class PiXIdeOpenTerminalAction : DumbAwareAction() {
    override fun update(event: AnActionEvent) {
        event.presentation.isEnabled = event.project != null
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        ApplicationManager.getApplication().invokeLater {
            try {
                val terminalSessionId = UUID.randomUUID().toString()
                val workingDirectory = terminalWorkingDirectoryForProject(project.basePath)
                val shellCommand = terminalCommandForProject(project.basePath, terminalSessionId)
                val tabBuilder = TerminalToolWindowTabsManager.getInstance(project)
                    .createTabBuilder()
                    .workingDirectory(workingDirectory)
                    .envVariables(mapOf(TERMINAL_SESSION_ENV to terminalSessionId))
                    .tabName("Pi")
                    .requestFocus(true)
                if (shellCommand != null) tabBuilder.shellCommand(shellCommand)
                val tab = tabBuilder.createTab()
                PiXIdeProjectService.getInstance(project).registerPiTerminal(tab, terminalSessionId)
                if (shellCommand == null) {
                    tab.view.createSendTextBuilder().shouldExecute().send("pi")
                }
                ToolWindowManager.getInstance(project).getToolWindow("Terminal")?.activate(null)
            } catch (error: Throwable) {
                PiXIdeAttachSelectionAction.notify(
                    project,
                    "Pi x IDE: failed to open Pi terminal: ${error.message ?: error.javaClass.simpleName}",
                    NotificationType.ERROR,
                )
            }
        }
    }
}
