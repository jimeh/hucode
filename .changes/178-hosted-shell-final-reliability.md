fix(omni): close hosted shell recovery gaps

Keep terminal hosted-workbench shutdown joined after dispatch, preserve
at-most-once clipboard behavior across controller timeouts, and recover cleanly
from hosted-shell and project-event transport failures.
