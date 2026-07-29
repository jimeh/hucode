fix(projects): bound serve-web request admission

Bound serve-web project queues so canceled waiting work releases promptly,
excess requests receive retry guidance, and shutdown settles queued requests
without interrupting admitted mutations.
