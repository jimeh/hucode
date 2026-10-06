# Onboarding route

Components specific to the onboarding host for
[#204](https://github.com/jimeh/hucode/issues/204).

The import route in `../import/` and the onboarding route share one bundle, one setup shell, and
the navigation, feedback, collection, and migration components in `../components/`. A snapshot's
`route` field says which surface it belongs to; the shell renders the same way for both, and the
panel switch in `../components/SetupPanel.tsx` picks up onboarding-only panel kinds from here.

- `BringPanel.tsx`: the first onboarding stage. It draws the host-supplied heading, lead, and
  paragraphs, and offers the two routes out of it as large buttons that post `chooseRoute`.
- `AppearancePanel.tsx`: the Skip Import route's appearance stage. The mode is a radio group
  drawn as one row of three tiles, styled like the Bring choices, that post each option's
  attached `selectMode` intent; each tile is named by its label alone and described by its
  detail. The preferred light and dark themes are two filterable radio lists side by side from
  the medium width up, stacked below it, that post `selectPreferredTheme` with an identifier the
  host listed. The lists sit in `VirtualCollection`, so hundreds of installed themes stay
  responsive. The host's paragraphs render as one muted note under the lead. While the host
  reads the themes it sends the shared `loading` panel, and after a failed read a `message`
  panel; both come from the migration components.
- `MeetOmniPanel.tsx`: the last stage. It draws the three-entry Omni glossary as a definition
  list and the shortcut table, and posts nothing itself; the finishes are footer actions.
  Shortcuts render the host-resolved chord in `<kbd>`, or the host's fallback text when none is
  bound; the renderer never formats key chords.

The embedded migration stages reuse the migration panels unchanged: the host lays onboarding's
title, step header, and scope over the migration presentation, and replaces the Results footer
with Copy Report, any Retry or Resume, and Continue, so nothing here switches on the route.

There is no separate onboarding entry point. The shared webview esbuild path has no code
splitting, so a second entry would duplicate React and every shared component, and its
hash-named chunks could not be probed by the host's fixed asset list.
