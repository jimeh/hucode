# Hucode Roadmap

## Phase 0: Fork Baseline

Goal:

- establish the fork as a buildable, branded Hucode baseline

Work:

- switch product branding to Hucode
- configure OpenVSX marketplace defaults
- document the fork and upgrade strategy
- verify the repo can build and launch locally

Validation:

- `npm install`
- `npm run watch`
- `./scripts/code.sh`

## Phase 1: Project Model And Sidebar

Goal:

- build the project and worktree model before changing the window shell

Work:

- add a persistent project registry
- add a git worktree service
- add a project switcher contribution in the existing workbench
- show projects with nested worktrees

This phase does not need multi-workspace hosting yet. It is mainly about
locking the data model and interaction design.

Validation:

- unit tests for project and worktree models
- manual testing for add, remove, rename, and refresh flows
- smoke test creating and removing a worktree from the UI

## Phase 2: Shell Host Prototype

Goal:

- move the project manager outside the workspace workbench and prove the shell
  model

Work:

- create a Hucode shell UI
- host one workspace in a `WebContentsView`
- hand off focus cleanly between shell and workspace
- route shell-level commands separately from workspace-level commands

Validation:

- shell launches and renders consistently on macOS
- switching from shell to hosted workspace preserves input focus
- reload and close flows still work

## Phase 3: Multi-Workspace Lifecycle

Goal:

- support multiple hosted workspaces with explicit lifecycle states

Work:

- keep more than one workspace loaded
- add `active`, `loaded`, `dormant`, and `unloaded` states
- allow unload without removing from the project registry
- persist enough state to restore the active set on restart

Validation:

- manual switching across multiple real projects
- verify hidden workspaces resume quickly
- verify unload frees resources without deleting project entries
- crash and restore testing

## Phase 4: Resource Policy

Goal:

- make multiple hosted workspaces practical on real machines

Work:

- add LRU or pinning policy for loaded workspaces
- add dormant-state heuristics
- expose memory-oriented controls in the shell UI
- tune extension host behavior where possible

Validation:

- compare memory and switch latency with one, three, and five loaded workspaces
- verify pinned workspaces are not auto-unloaded

## Phase 5: Polish

Goal:

- make the product feel coherent rather than experimental

Work:

- tighten shell visual design
- improve drag, reorder, and search behavior in the project switcher
- refine context menus and keyboard shortcuts
- add onboarding for first project import and first worktree creation

Validation:

- focused UX pass on macOS
- regression pass for keyboard navigation and accessibility
- packaging and release smoke tests

## Design Principles

- keep the shell small and explicit
- preserve upstream workbench behavior inside each workspace
- keep destructive git actions intentional and well-labeled
- prefer additive seams over deep rewrites
