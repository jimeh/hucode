feat(onboarding): add the modal Hucode onboarding experience

Add Hucode: Open Onboarding, a three-stage flow in the Omni modal editor.
Bring Your Setup embeds the existing editor setup import or skips it;
Skip Import offers a System, Light, or Dark mode with preferred light and
dark themes, prefilled from the current values and written to the Default
profile as each choice is made; Meet Omni explains projects, worktrees, and
workbenches and lists the switching shortcuts, then hands off to Add
Project, Open Folder as Workbench, or Finish for Now.

Onboarding keeps a versioned installation-scoped record. Escape or Do This
Later records a resumable step, Skip and completion are explicit, and
reopening a completed installation changes nothing on its own. Nothing
opens onboarding automatically yet.

Generalize the setup webview host around a presenter so the import command
and onboarding share one renderer, one protocol, and one validator set.
