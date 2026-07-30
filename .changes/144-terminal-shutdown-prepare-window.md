fix(terminal): preserve state between shutdown phases

Prevent terminal layout saves from overwriting the prepared process snapshot
while shutdown vetoes are still settling.
