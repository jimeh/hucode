fix(changelog): ignore fragments owned by another pull request

Change-fragment validation no longer requires a pull request title to match
fragments that are already numbered for a different pull request. An
integration branch carrying several merged pull requests, or a branch that
merged an updated base, is no longer rejected for carrying fragments it does
not own.
