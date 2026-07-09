fix: backport upstream automation dialog performance fix

Backport the pending VS Code fix from microsoft/vscode#324986 to avoid the
1.128.0 workbench performance regression from `body:has(.automation-dialog)`.
