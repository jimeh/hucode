fix(projects): clean up workbenches before project removal

Attempt to unload every hosted workbench owned by a project before removing
that project, without discarding workbenches that veto or time out during
shutdown.
