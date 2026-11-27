fix(sessions): open the Agents window instead of a blank window

The Agents window, opened from the welcome page or `--agents`, now renders
instead of staying blank. Its renderer was missing Hucode's desktop service
registrations.
