fix(release): restore Linux RPM and Windows arm64 builds

Linux DEB and RPM packages install their desktop entries as
`dev.hucode.app.desktop` instead of `hucode.desktop`, following the VS Code
1.139 desktop-name change. Launchers pinned to the old entry need to be pinned
again after upgrading.
