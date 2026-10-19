# Electron App Build Rule
Whenever you modify source code in this Electron app, you MUST run `npm run pack` after finishing your changes. This ensures that the packaged executable in the `release/win-unpacked` directory is updated, so the user's taskbar shortcut launches the latest version.
Always when you rebuild the app and close it, after you are done packing, relaunch the app (`release/win-unpacked/Notes.exe`).
Always ensure that the app is reopened and left running at the end of every task or change.

