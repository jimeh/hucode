feat(omni): support independent profiles and global workbench ownership

Hosted Omni workbenches can use and switch independent VS Code profiles while
the shell follows the active workbench's theme and Modern UI appearance.
Desktop windows now share canonical-path ownership, and same-browser serve-web
tabs coordinate ownership without creating duplicate hosted workbenches.
