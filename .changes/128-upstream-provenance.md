feat(upgrade): detect drift in forked upstream files

Record the upstream source and synchronized baseline for forked Omni workbench
files, fail upgrades when those sources change, and derive upstream-named CI
suite ownership from the same provenance inventory.
