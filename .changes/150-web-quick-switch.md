fix(omni): keep web quick switches on the selected workbench

Make workbench quick switching in `hucode serve-web` retain and focus the
selected target, including next and previous loaded-workbench commands. Hosted
web switchers now also identify the current workbench from shell state so the
most recently active alternative is selected by default. Ordinary hosted
folder opens use the same race-safe activation path.
