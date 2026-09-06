feat(onboarding): add the onboarding modal host and state

Add the Hucode onboarding session, versioned installation-scoped state, and
modal editor host with a placeholder Bring Your Setup stage. Skip records the
choice, and Escape, outside-click, or Do This Later record a resumable step.
The open command exists but stays out of the Command Palette until the flow
has its route content.

Generalize the setup webview host around a presenter so the import command and
onboarding share one renderer, one protocol, and one validator set.
