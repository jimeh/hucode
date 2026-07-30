fix(lifecycle): preserve workbench state across shutdown vetoes

Keep browser and desktop workbenches usable after vetoed shutdown preparation,
while excluding transient debug and task state from committed restoration.
