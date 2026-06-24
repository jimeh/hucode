fix: preserve VS Code product version for pending updates

Ensure macOS pending-update metadata keeps the VS Code compatibility version
after Squirrel.Mac rewrites downloaded update fields, so the Extensions UI does
not mark installed extensions incompatible with the Hucode app release version.
