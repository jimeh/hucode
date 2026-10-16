fix(projects): stop retaining project catalog snapshots in desktop IPC

The desktop main process no longer buffers project manager change events on
its renderer channel. No renderer subscribed to catalog changes there, so every
catalog snapshot was kept in memory for the lifetime of the app. Project list
changes could be retained the same way in sessions without an Omni window.
