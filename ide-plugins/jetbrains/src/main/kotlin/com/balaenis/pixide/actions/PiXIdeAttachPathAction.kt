// ABOUTME: Sends files or directories selected in JetBrains context menus to Pi.
// ABOUTME: Reuses the existing at-mentioned protocol with path-only snapshots.
package com.balaenis.pixide.actions

import com.balaenis.pixide.editor.PiXIdeWorkspace
import com.balaenis.pixide.protocol.EditorSelectionSnapshot
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.PlatformCoreDataKeys
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiFileSystemItem

class PiXIdeAttachPathAction : DumbAwareAction() {
    override fun update(event: AnActionEvent) {
        event.presentation.isEnabledAndVisible = event.project != null
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        selectedFiles(event).forEach { file ->
            PiXIdeAttachSelectionAction.attach(
                project,
                EditorSelectionSnapshot(
                    filePath = file.path,
                    workspaceFolder = PiXIdeWorkspace.bestWorkspaceFolder(project, file.path),
                    ranges = emptyList(),
                ),
            )
        }
    }

    private fun selectedFiles(event: AnActionEvent): List<VirtualFile> =
        event.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY)?.toList()?.takeIf(List<VirtualFile>::isNotEmpty)
            ?: event.getData(CommonDataKeys.VIRTUAL_FILE)?.let(::listOf)
            ?: event.getData(PlatformCoreDataKeys.PSI_ELEMENT_ARRAY)
                ?.mapNotNull { (it as? PsiFileSystemItem)?.virtualFile }
                .orEmpty()
}
