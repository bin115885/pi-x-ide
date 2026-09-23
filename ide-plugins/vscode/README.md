# Pi x IDE

Pi x IDE connects VS Code with Pi so your active file and selected text can be sent as editor context.

## Features

- Tracks the active VS Code file for Pi
- Sends selected text ranges as context
- Provides a status bar action to attach the current selection
- Provides an editor title action to open Pi in the integrated terminal
- Supports manual attachment with a command or keyboard shortcut
- Adds Quick Fix actions, **Pi: Fix it** and **Pi: Send diagnostic**, for error and warning diagnostics while Pi is connected

## Usage

Use the command palette and run:

```text
Pi x IDE: Attach Selection to Pi
```

Default shortcut:

- Linux/Windows: `Ctrl+Alt+K`
- macOS: `Cmd+Alt+K`

When no text is selected, Pi receives the active file reference. When text is selected, Pi receives a line-range reference (the selection text is available as IDE context).

Right-click selected code in the editor, or a file/folder in Explorer (including editor tabs), to attach an `@path` or `@path#Lx-Ly` reference. Attachments go only to the selected Pi terminal in the same VS Code workspace; the terminal is focused after sending. Plugin-created terminals and terminals where you directly ran `pi` are supported. Restart Pi after updating this extension so it reports its workspace and terminal process. Selections outside a workspace, mismatched projects, and ambiguous terminals are not sent.
For diagnostics, select a Pi terminal in the same workspace, then place the cursor on an error or warning and open Quick Fix. The Pi diagnostic actions appear while a Pi client is connected. **Pi: Fix it** sends the diagnostic details and nearby source context to the selected Pi session and starts a diagnostic-analysis turn using the built-in prompt template. **Pi: Send diagnostic** sends the same context to that session's input box without starting a turn.

## Settings

| Key              | Default | Description                                          |
| ---------------- | ------- | ---------------------------------------------------- |
| `piXIde.useTmux` | `false` | Open `Pi Tui` with `tmux` when opening the terminal. |
