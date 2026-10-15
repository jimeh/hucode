fix(projects): stop retaining project catalog snapshots in desktop IPC

The desktop main process no longer buffers project catalog change events on
the project manager channel, which has no renderer subscriber for them. Every
catalog snapshot was previously kept in memory for the lifetime of the app.
