# Changelog

All notable changes to Hucode are documented in this file.

## 0.0.58 - 2026-07-27

### Features

- **release:** attest release asset provenance (#112)

### Bug Fixes

- **changelog:** ignore fragments owned by another pull request (#114)
- **omni:** release destroyed hosted workspace controllers (#109)

### Miscellaneous Chores

- merge the 1.130.0 hardening base into mainline (#113)

## 0.0.57 - 2026-07-23

### Features

- **deps:** upgrade VS Code baseline to 1.130.0

## 0.0.56 - 2026-07-23

### Miscellaneous Chores

- **license:** correct Hucode source attribution (#103)

## 0.0.55 - 2026-07-23

### Features

- **cli:** default serve-web to the Omni shell (#102)

### Bug Fixes

- **omni:** restore MRU workbench picker ordering (#99)

## 0.0.54 - 2026-07-22

### Features

- **omni:** suspend hosted workbenches (#97)

### Bug Fixes

- **terminal:** support OSC 52 clipboard in serve-web (#96)
- **webview:** prevent listener buildup during high-fan-out resource loads (#98)

## 0.0.53 - 2026-07-20

### Bug Fixes

- **omni:** enable worktree creation on web (#95)

## 0.0.52 - 2026-07-20

### Bug Fixes

- **omni:** enable project renaming on web (#94)

## 0.0.51 - 2026-07-20

### Features

- **omni:** add Projects tree indent setting (#93)

## 0.0.50 - 2026-07-19

### Features

- **deps:** upgrade VS Code baseline to 1.129.1

## 0.0.49 - 2026-07-19

### Features

- **deps:** upgrade VS Code baseline to 1.129.0

## 0.0.48 - 2026-07-19

### Features

- add retained workbenches to Omni (#91)

### Bug Fixes

- refine retained Omni workbench interactions (#92)

## 0.0.47 - 2026-07-17

### Features

- **linux:** provide Omni window parity (#90)
- **release:** publish and advertise Linux desktop builds (#88)

### Bug Fixes

- brand serve-web with Hucode icons (#84)
- **linux:** make desktop packages safe and correctly branded (#89)

## 0.0.46 - 2026-07-15

### Features

- **deps:** upgrade VS Code baseline to 1.128.1

## 0.0.45 - 2026-07-15

### Bug Fixes

- package OpenVSX signature verifier in serve-web archives (#82)

## 0.0.44 - 2026-07-14

### Bug Fixes

- **release:** restore macOS and Linux x64 builds (#80)

## 0.0.43 - 2026-07-14

### Features

- **release:** publish standalone Hucode CLI assets (#79)

## 0.0.42 - 2026-07-09

### Bug Fixes

- backport upstream automation dialog performance fix (#78)

## 0.0.41 - 2026-07-08

### Features

- **deps:** upgrade VS Code baseline to 1.128.0

## 0.0.40 - 2026-07-07

### Features

- **deps:** upgrade VS Code baseline to 1.127.0

## 0.0.39 - 2026-07-07

### Features

- **deps:** upgrade VS Code baseline to 1.126.0

## 0.0.38 - 2026-07-06

### Features

- add serve-web Omni shell route (#77)

## 0.0.37 - 2026-06-25

### Bug Fixes

- prioritize worktree labels in Projects (#76)

## 0.0.36 - 2026-06-24

### Bug Fixes

- preserve VS Code product version for pending updates (#75)

## 0.0.35 - 2026-06-24

### Bug Fixes

- align Omni worktree ref picker with checkout (#73)

## 0.0.34 - 2026-06-21

### Bug Fixes

- stabilize built-in extension cache for Omni (#72)

## 0.0.33 - 2026-06-18

### Bug Fixes

- separate Hucode and VS Code update versions (#71)

## 0.0.32 - 2026-06-18

### Features

- **deps:** upgrade VS Code baseline to 1.125.0

## 0.0.31 - 2026-06-13

### Features

- **deps:** upgrade VS Code baseline to 1.124.2

## 0.0.30 - 2026-06-11

### Continuous Integration

- catch Copilot VSIX release drift in PRs (#68)
- keep win32 x64 release builds on VS 2022 (#69)

## 0.0.29 - 2026-06-10

### Features

- **deps:** upgrade VS Code baseline to 1.124.0

## 0.0.28 - 2026-06-10

### Bug Fixes

- align serve-web CLI server entrypoint (#66)

## 0.0.27 - 2026-06-10

### Bug Fixes

- keep Hucode serve-web assets aligned (#65)
- use a Hucode shared data folder (#65)

## 0.0.26 - 2026-06-09

### Bug Fixes

- keep macOS serve-web release assets usable (#64)

## 0.0.25 - 2026-06-08

### Bug Fixes

- keep missing hosted worktrees reachable (#60)
- show Hucode update identity in product UI (#62)
- **changelog:** retain PR attribution for unnumbered fragments (#61)

### Code Refactoring

- decouple Omni from agent-session UI (#59)

## 0.0.24 - 2026-06-05

### Features

- **deps:** upgrade VS Code baseline to 1.123.0

## 0.0.23 - 2026-05-30

### Features

- **deps:** upgrade VS Code baseline to 1.122.1

## 0.0.22 - 2026-05-29

### Features

- **deps:** upgrade VS Code baseline to 1.122.0

## 0.0.21 - 2026-05-29

### Features

- **update:** enable built-in Hucode updater (#57)

## 0.0.20 - 2026-05-28

### Continuous Integration

- **release:** publish macOS ZIP assets alongside DMGs (#56)

## 0.0.19 - 2026-05-26

### Bug Fixes

- stabilize Omni worktree delete overlays (#55)
