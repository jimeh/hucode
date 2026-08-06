feat(omni): add a bound hosted shell capability

Hosted serve-web workbenches now use a versioned, instance-bound shell
capability that exposes only self-scoped state and operations while preserving
one generation of cached-client compatibility.
