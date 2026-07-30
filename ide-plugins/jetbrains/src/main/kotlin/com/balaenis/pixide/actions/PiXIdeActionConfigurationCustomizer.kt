// ABOUTME: Registers Send to Pi in Commit tool window popup menus.
// ABOUTME: Covers both classic ChangesView and Git Staging Area (Git.Stage.Tree.Menu).
package com.balaenis.pixide.actions

import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.actionSystem.impl.ActionConfigurationCustomizer
import com.intellij.openapi.diagnostic.Logger

@Suppress("OVERRIDE_DEPRECATION")
class PiXIdeActionConfigurationCustomizer : ActionConfigurationCustomizer {
    override fun customize(actionManager: ActionManager) {
        val action = actionManager.getAction(ACTION_ID) ?: return
        for (groupId in POPUP_GROUP_IDS) {
            val group = actionManager.getAction(groupId) as? DefaultActionGroup ?: continue
            group.add(action, actionManager)
            LOG.info("Registered $ACTION_ID into $groupId")
        }
    }

    private companion object {
        const val ACTION_ID = "PiXIde.AttachProjectPath"
        val POPUP_GROUP_IDS = listOf(
            "ChangesViewPopupMenu",
            "ChangesViewPopupMenuShared",
            "Git.Stage.Tree.Menu",
        )
        val LOG = Logger.getInstance(PiXIdeActionConfigurationCustomizer::class.java)
    }
}
