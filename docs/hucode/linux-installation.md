# Linux Installation And Updates

Hucode publishes Linux x64 and arm64 desktop builds on the
[latest GitHub Release](https://github.com/jimeh/hucode/releases/latest).
Choose the architecture reported by `uname -m`:

| `uname -m` | Hucode architecture |
| --- | --- |
| `x86_64` | `x64` |
| `aarch64` or `arm64` | `arm64` |

Then choose one package format:

- DEB (`hucode-linux-<arch>.deb`) for Debian, Ubuntu, and derivatives.
- RPM (`hucode-linux-<arch>.rpm`) for Fedora, RHEL, and derivatives.
- ZIP (`hucode-linux-<arch>.zip`) for an unpacked, package-manager-independent
  installation.

Linux armhf packages are build artifacts only and are not public release
assets. Hucode does not currently publish Snap or AppImage packages.

## Verify A Download

Each release includes `SHA256SUMS`. Download it beside the package, then run:

```sh
sha256sum --check --ignore-missing SHA256SUMS
```

The selected package must report `OK` before installation.

## Install Or Upgrade

Installing a newer DEB or RPM upgrades an existing installation in place:

```sh
sudo apt install ./hucode-linux-x64.deb
```

```sh
sudo dnf install ./hucode-linux-x64.rpm
```

Replace `x64` with `arm64` on an arm64 system. For ZIP installations, close
Hucode, extract the new ZIP, and replace the previous extracted directory while
keeping user data outside that directory.

Hucode checks `updates.hucode.dev` for newer releases. On Linux, the built-in
update action always opens the latest GitHub Release so the user can choose the
same package format manually. Hucode does not automatically install Linux
updates and does not add or modify APT, DNF, or YUM package sources.
