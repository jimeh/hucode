feat(omni): bind desktop hosted shell capabilities

Route desktop hosted workbenches through a per-instance, generation-scoped
MessagePort instead of using the broad Omni shell service client.
