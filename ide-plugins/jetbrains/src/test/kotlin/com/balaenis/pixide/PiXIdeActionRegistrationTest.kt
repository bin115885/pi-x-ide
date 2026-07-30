// ABOUTME: Verifies the Send to Pi action is registered in Commit popup menus.
// ABOUTME: Covers classic ChangesView and prevents duplicate Git Staging Area entries.
package com.balaenis.pixide

import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.testFramework.fixtures.BasePlatformTestCase

class PiXIdeActionRegistrationTest : BasePlatformTestCase() {
    fun testCommitPopupContainsAttachAction() {
        val actionManager = ActionManager.getInstance()
        val group = actionManager.getAction("ChangesViewPopupMenu") as DefaultActionGroup
        val actionIds = group.getChildren(actionManager).mapNotNull(actionManager::getId)

        assertContainsElements(actionIds, "PiXIde.AttachProjectPath")
    }

    fun testGitStagePopupContainsAttachActionWhenAvailable() {
        val actionManager = ActionManager.getInstance()
        val group = actionManager.getAction("Git.Stage.Tree.Menu") as? DefaultActionGroup ?: return
        val actionIds = group.getChildren(actionManager).mapNotNull(actionManager::getId)

        assertEquals(1, actionIds.count { it == "PiXIde.AttachProjectPath" })
    }
}
