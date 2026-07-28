# Install the JetBrains plugin

Pi × IDE integrates with IntelliJ IDEA, PyCharm, WebStorm, and other JetBrains
IDEs through a marketplace plugin.

## Prerequisites

- The [`pi`](https://github.com/earendil-works/pi-coding-agent) CLI installed.
- The `pi-x-ide` Pi package installed: `pi install npm:pi-x-ide`.
- A JetBrains IDE (2024.2 or later recommended).

## Install from the JetBrains Marketplace

1. In your IDE, open **Settings / Preferences -> Plugins -> Marketplace**.
2. Search for `balaenis.pi-x-ide`.
3. Click **Install**, then restart the IDE when prompted.

The plugin is also listed on the
[JetBrains Marketplace](https://plugins.jetbrains.com/plugin/32664-pi-x-ide).

## Verify the connection

1. Open a project in your JetBrains IDE.
2. Run **Pi x IDE: Open Pi Terminal** from Find Action or the toolbar. The plugin opens a dedicated Pi terminal and associates it with that Pi session.

3. Open a source file and select some text. The Pi widget should show:

   ```
   ⧉ ⇡ foo.ts#L10-L20
   ```

If the widget does not appear, see
[Troubleshoot a missing connection](troubleshoot-connection.md).

## Attach a selection

With text selected in the editor, do either of the following:

- Press `Ctrl+Alt+K` (Linux/Windows) or `Cmd+Alt+K` (macOS).
- Run the **Pi x IDE: Attach Selection** action from the Find Action dialog
  (`Ctrl+Shift+A` / `Cmd+Shift+A`).
- Right-click the selected code and choose **Pi x IDE: Attach Selection**.

Pi inserts `@relative/path#Lx-Ly` into the input box. Submit your message to send
the selected text as LLM context.

## Notes

- JetBrains sends selection notifications for both non-empty selections and an
  active file with no selected text.
- With multiple plugin-created Pi terminals, manual attach is sent only to the Pi tab most recently selected in the Terminal tool window. If no plugin-created Pi tab is selected, Pi x IDE warns and sends nothing.
- Diagnostic Quick Fix and auto-install are VS Code-family features and are not
  available for JetBrains. See the
  [feature parity](../reference/feature-parity.md) table.
- For local development and sandbox testing, see
  [CONTRIBUTING.md](../../CONTRIBUTING.md).
