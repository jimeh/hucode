# Onboarding route

Reserved for the full-window onboarding host in
[#204](https://github.com/jimeh/hucode/issues/204).

The import route in `../import/` and the future onboarding route share the setup shell,
navigation, feedback, collection, and migration components in `../components/`. They do not share
host-specific navigation state: each route owns its own entry point and its own host framing.

Nothing in this directory ships in #203.
