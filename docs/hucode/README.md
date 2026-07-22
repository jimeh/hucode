# Hucode Documentation

Hucode is a VS Code fork built around Omni: a persistent shell for navigating
projects, git worktrees, and several hosted workbenches without opening a
separate application window for each one.

## Using Hucode

- [Omni](omni.md) explains projects, workbenches, lifecycle actions, settings,
  and the differences between desktop and serve-web.
- [Linux Installation and Updates](linux-installation.md) covers public Linux
  packages and manual upgrades.
- [Roadmap](roadmap.md) summarizes what exists today, what is being hardened,
  and what remains exploratory.

## Understanding Hucode

- [Architecture](architecture.md) describes the current runtime shape, module
  ownership, and design invariants.
- [Repository Strategy](repo-strategy.md) explains the rolling `series-*`
  development model and the VS Code upgrade process.
- [Release Guide](release.md) documents versions, change fragments, CI builds,
  public assets, signing, and updates.

## Developing Hucode

- [Development Guide](development.md) covers setup, the Hucode overlay, common
  commands, and validation.
- [Agent Instructions](agent-instructions.md) contains detailed operational
  rules and hard-won gotchas for automated contributors. Humans changing
  Hucode internals should consult it too.
- [VS Code Upgrade Skill](../../.agents/skills/hucode-upgrade-vscode/SKILL.md)
  is the executable, step-by-step upgrade procedure for coding agents.

## Historical Design Records

Completed plans and investigations are retained in [archive](archive/) for
decision history. They describe the state and assumptions at the time they
were written; the guides above are the source of truth for current behavior.

- [Omni Workbenches and Projects Plan](archive/omni-workbenches-plan.md)
- [Serve-Web Omni Plan](archive/serve-web-omni-plan.html)
- [Serve-Web Omni Self-Review](archive/serve-web-omni-self-review.md)
- [Release Build Size Analysis](archive/release-build-size-analysis.md)

When behavior changes, update the smallest current guide that owns the
contract. Add implementation-specific pitfalls to `agent-instructions.md`, and
move completed execution plans into `archive/` instead of leaving them mixed
with current guidance.
