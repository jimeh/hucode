fix(omni): enforce hosted shell ownership boundaries

Limit hosted workbenches to their assigned shell authority, preserve teardown
ownership across focus and shutdown races, and avoid duplicate clipboard
operations when delivery is uncertain.
