fix(omni): keep focus in the hosted workbench after context menu actions

Running an action from a native context menu in a hosted workbench moved
keyboard focus to the Projects sidebar. Renaming a file from the Explorer
context menu therefore opened the name input without focus until Escape
returned focus to the workbench. A hosted workbench that asks for window focus
now receives it itself, while the owning window is still raised.
