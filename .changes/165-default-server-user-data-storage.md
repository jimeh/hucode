feat(cli): default serve-web user data to server storage

Serve-web now shares settings, profiles, and workbench state across browsers by
default. Pass `--user-data-storage=browser` to retain browser-local storage.
