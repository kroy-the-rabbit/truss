# Installation and Upgrade Guide

This guide is for production desktop installs of Truss (`1.0.x`).

## Supported Release Artifacts

Truss publishes desktop binaries for:
- Linux: AppImage (`x64`, `arm64`)
- macOS: DMG (`x64`, `arm64`)
- Windows: NSIS installer (`x64`, `arm64`)

Artifact naming:
- `truss-<version>-linux-<arch>.AppImage`
- `truss-<version>-macos-<arch>.dmg`
- `truss-<version>-windows-<arch>.exe`

## Before You Install (Production Checklist)

- Download from the official GitHub Releases page for this repository.
- Verify checksums/signatures using `KEYS`, `SHA256SUMS`, and `SHA256SUMS.asc`.
- Decide your vault mode before first use:
  - `password` mode for portable local-only usage
  - `gpg` mode if you already rely on a local GPG key / hardware token
- Ensure required Kubernetes credential helpers are installed if your kubeconfig uses `exec` auth (for example `gke-gcloud-auth-plugin`, `aws`, `kubelogin`, etc.).

## Verify Release Artifacts (Recommended)

```bash
# Import release signing key included in this repo
gpg --import KEYS

# Optional fingerprint check
gpg --fingerprint CD786AF6C8054E3630457321899FF2FEE3CD9D96

# Verify signed checksum manifest
gpg --verify SHA256SUMS.asc SHA256SUMS

# Verify artifact checksums
sha256sum -c SHA256SUMS
```

On macOS, use `shasum -a 256 -c SHA256SUMS` if `sha256sum` is unavailable.

## Install

### Linux (AppImage)

```bash
chmod +x truss-<version>-linux-<arch>.AppImage
./truss-<version>-linux-<arch>.AppImage
```

Optional desktop integration:
- Place the AppImage in a stable path (for example `~/Applications/`)
- Create a desktop launcher or use your preferred AppImage integration tooling

### macOS (DMG)

1. Open the `.dmg`
2. Drag `Truss.app` to `Applications`
3. Launch `Truss`

If Gatekeeper blocks first launch:

```bash
xattr -cr /Applications/Truss.app
```

Then right-click `Truss.app` -> `Open`.

### Windows (NSIS Installer)

1. Run `truss-<version>-windows-<arch>.exe`
2. Choose install path (the installer is configured to allow changing it)
3. Launch Truss from Start Menu / desktop shortcut

## First Run Setup

1. Initialize the vault (`password` or `gpg`)
2. Import contexts from `~/.kube/config` or paste kubeconfig YAML
3. Confirm active profile / context
4. Leave Truss in `RO` mode while validating access
5. Open `Overview` to confirm cluster connectivity and cache warm-up

## Upgrade

Truss stores user data separately from the application binary, so upgrades are usually in-place.

User data location:
- Linux/macOS: `~/.config/truss/`
- Windows: `%AppData%\\truss\\`

Typical upgrade flow:
1. Close Truss
2. Install the new version (replace app bundle / run installer / use new AppImage)
3. Launch Truss
4. Verify vault unlock and cluster connectivity

Recommended before major upgrades:
- Back up `contexts.enc`
- Back up `preferences.json`
- Export plugin directory if you use custom plugins

## Rollback

If a release causes issues:
1. Close Truss
2. Reinstall a previous known-good release artifact
3. Keep your existing `~/.config/truss/` (or `%AppData%\\truss\\`) directory intact unless explicitly troubleshooting corruption

If the vault format changes in a future major release, the release notes will call out migration/rollback constraints.

## Uninstall

### App binaries
- Linux AppImage: delete the AppImage file (and any desktop entry you created)
- macOS: remove `Truss.app` from `Applications`
- Windows: uninstall via Settings -> Apps (or Control Panel)

### Optional user data removal (destructive)

This deletes your encrypted vault, preferences, plugins, and local caches.

- Linux/macOS: remove `~/.config/truss/`
- Windows: remove `%AppData%\\truss\\`

## Air-Gapped / Restricted Environments

Truss is a local desktop app and does not require a cloud service to function.

You may still need:
- Kubernetes API network reachability from your workstation
- Any kubeconfig `exec` auth helpers available on local `PATH`
- Local GPG tooling if using GPG vault mode

## Troubleshooting Install/Upgrade Issues

See [docs/OPERATIONS.md](OPERATIONS.md) for common issues including:
- credential helper path problems
- Gatekeeper launch blocks
- slow first load / cache warm-up on large clusters
- vault recovery/reset workflow
