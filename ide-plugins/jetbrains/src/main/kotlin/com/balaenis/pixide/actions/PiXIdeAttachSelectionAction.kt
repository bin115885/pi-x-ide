// ABOUTME: Implements the JetBrains action that attaches the active file or selection to Pi.
// ABOUTME: Sends at_mentioned notifications when Pi is connected and surfaces user-facing status balloons.
package com.balaenis.pixide.actions

import com.balaenis.pixide.PiXIdeProjectService
import com.balaenis.pixide.editor.PiXIdeSnapshotBuilder
import com.balaenis.pixide.protocol.EditorSelectionSnapshot
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project

class PiXIdeAttachSelectionAction : DumbAwareAction() {
    override fun update(event: AnActionEvent) {
        val editor = event.getData(CommonDataKeys.EDITOR)
        event.presentation.isEnabledAndVisible = event.project != null &&
            (editor == null || PiXIdeSnapshotBuilder.isAttachableEditor(event.dataContext, editor))
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val editor = event.getData(CommonDataKeys.EDITOR)
        if (editor != null && !PiXIdeSnapshotBuilder.isAttachableEditor(event.dataContext, editor)) return
        val contextFile = editor?.let { PiXIdeSnapshotBuilder.contextFile(event.dataContext, it) }
        val snapshot = PiXIdeSnapshotBuilder.snapshot(
            project = project,
            preferredEditor = editor,
            contextFile = contextFile,
        )
        attach(project, snapshot)
    }

    companion object {
        private const val NOTIFICATION_GROUP = "Pi x IDE Notifications"

        fun attach(project: Project) {
            showResult(project, PiXIdeProjectService.getInstance(project).attachCurrentSelection())
        }

        fun attach(project: Project, snapshot: EditorSelectionSnapshot?) {
            showResult(project, PiXIdeProjectService.getInstance(project).attachSelection(snapshot))
        }

        private fun showResult(project: Project, result: PiXIdeProjectService.AttachResult) {
            when (result) {
                is PiXIdeProjectService.AttachResult.Attached -> {
                    notify(project, "Pi x IDE attached ${result.rangeText}", NotificationType.INFORMATION)
                }
                is PiXIdeProjectService.AttachResult.TargetNotConnected -> {
                    notify(
                        project,
                        "Pi x IDE: the selected Pi terminal is not connected. Reference: ${result.rangeText}",
                        NotificationType.WARNING,
                    )
                }
                PiXIdeProjectService.AttachResult.NoActiveFile -> {
                    notify(project, "Pi x IDE: no active file to attach.", NotificationType.WARNING)
                }
                PiXIdeProjectService.AttachResult.NoActivePiTerminal -> {
                    notify(project, "Pi x IDE: select a Pi terminal opened by the plugin first.", NotificationType.WARNING)
                }
            }
        }

        fun notify(project: Project, content: String, type: NotificationType) {
            NotificationGroupManager.getInstance()
                .getNotificationGroup(NOTIFICATION_GROUP)
                .createNotification(content, type)
                .notify(project)
        }
    }
}
