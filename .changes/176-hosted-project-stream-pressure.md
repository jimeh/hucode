fix(omni): prevent hosted project stream exhaustion

Keep hosted workbench switching on the shell-owned project snapshot so opening
several serve-web workbenches does not consume one project event stream per
child.
