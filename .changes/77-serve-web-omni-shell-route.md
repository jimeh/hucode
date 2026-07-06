feat: add serve-web Omni shell route

Adds `hucode serve-web --omni`, which serves the Hucode-owned Projects shell
at the root URL with the regular workbench at `/workbench` and hosted shell
workbenches at `/omni/workbench`. All Omni web routes and the same-origin
Projects API are enabled only when `--omni` is passed; without it serve-web
keeps upstream behavior.
