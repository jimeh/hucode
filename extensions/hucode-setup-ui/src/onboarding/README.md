# Onboarding route

Components specific to the onboarding host for
[#204](https://github.com/jimeh/hucode/issues/204).

The import route in `../import/` and the onboarding route share one bundle, one setup shell, and
the navigation, feedback, collection, and migration components in `../components/`. A snapshot's
`route` field says which surface it belongs to; the shell renders the same way for both, and the
panel switch in `../components/SetupPanel.tsx` picks up onboarding-only panel kinds from here.

- `BringPanel.tsx`: the first onboarding stage. It draws the host-supplied heading, lead, and
  paragraphs, and offers the two routes out of it as large buttons that post `chooseRoute`.

The embedded migration stages reuse the migration panels unchanged: the host lays onboarding's
title, step header, and scope over the migration presentation, so nothing here switches on the
route. The appearance and Meet Omni stages are `message` panels until their content lands.

There is no separate onboarding entry point. The shared webview esbuild path has no code
splitting, so a second entry would duplicate React and every shared component, and its
hash-named chunks could not be probed by the host's fixed asset list.
