fix(projects): preserve active reads during shutdown

Keep serve-web project reads alive through shutdown so shared hydration and
metadata watchers finish before the project manager and its final server
lifetime lease are released.
