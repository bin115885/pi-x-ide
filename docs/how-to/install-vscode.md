# Install the VS Code extension

Pi × IDE integrates with VS Code, Cursor, and Windsurf through a single extension.
This guide covers the three install paths and how to verify the connection.

## Prerequisites

- The [`pi`](https://github.com/earendil-works/pi-coding-agent) CLI installed.
- The `pi-x-ide` Pi package installed: `pi install npm:pi-x-ide`.
- VS Code, Cursor, or Windsurf.

## Option A: Install from the Marketplace (recommended)

Open your IDE's **Extensions** panel and search for
[`balaenis.pi-x-ide`](https://marketplace.visualstudio.com/items?itemName=balaenis.pi-x-ide),
then install it. Reload the window after installing.

## Optional: Auto-install on Pi startup

When explicitly enabled with `PI_X_IDE_AUTO_INSTALL=1`, Pi can install or update
the Marketplace extension from a supported VS Code integrated terminal.
This is disabled by default. See the
[configuration reference](../reference/configuration.md) for all Pi-side options.

## Verify the connection

1. Open a project folder in your IDE.
2. Open an integrated terminal in that folder and start Pi:

   ```bash
   pi
   ```

3. Open a source file and select some text. The Pi widget should show:

   ```
   ⧉ ⇡ foo.ts#L10-L20
   ```

If the widget does not appear, see
[Troubleshoot a missing connection](troubleshoot-connection.md).

## VS Code settings

| Key              | Type      | Default | Description                                                                                                                   |
| ---------------- | --------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `piXIde.useTmux` | `boolean` | `false` | Open Pi through `tmux` from the terminal icon. Each click creates a new session that is destroyed when the terminal detaches. |

## Diagnostic Quick Fix

Place the cursor on an error or warning, open Quick Fix (`Ctrl+.`), and choose:

- **Pi: Fix it** - sends the diagnostic to Pi and starts an analysis turn.
- **Pi: Send diagnostic** - pastes the diagnostic context into the Pi input box
  without starting a turn.

The prompt prefix used by **Pi: Fix it** is configurable via `fixPrompt`. See
[Configuration](../reference/configuration.md#top-level-options).
