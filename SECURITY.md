# Security Policy

## Scope

This policy covers the Truss desktop application, including:
- Electron frontend (`app/`)
- local backend daemon (`backend/` / `trussd`)
- release artifacts and signing guidance
- plugin interfaces and local storage behavior

## Supported Versions

Security fixes are targeted at the current stable release line and the next pre-release line under active development.

As a rule:
- Latest stable (`1.x`) receives security fixes
- Current pre-release (`1.x.y-...`) may receive fixes before the next stable patch
- Older unsupported lines may not receive backports

## Reporting a Vulnerability

Please do **not** open a public GitHub issue for sensitive security reports.

Preferred reporting paths:
1. GitHub Security Advisory private report (if enabled for this repository)
2. Email the maintainer: `kroy@kroy.io`

Please include:
- affected version(s)
- platform (Linux/macOS/Windows)
- reproduction steps or proof-of-concept
- impact assessment (credential disclosure, privilege bypass, RCE, etc.)
- any suggested mitigation or patch if available

## Disclosure Process

The project aims to:
- acknowledge reports promptly
- validate and reproduce the issue
- ship a fix or mitigation in the next appropriate release
- publish release notes describing impact and remediation

If a report cannot be reproduced, additional diagnostic detail may be requested.

## Security Model Summary

Truss is a local-first desktop app for a trusted workstation. It is not a hosted service.

Key design points:
- local backend binds to `127.0.0.1` only
- per-launch bearer token protects renderer/backend requests
- WebSocket auth uses header token (no query-token fallback)
- encrypted local credential vault (`contexts.enc`)
- Electron renderer isolation and sandbox enabled
- plugin code is privileged by design

## Security Expectations and Non-Goals

Expected by design:
- Truss uses the same Kubernetes access your local credentials allow
- RBAC restrictions from the cluster still apply
- local plugins can perform powerful actions if enabled

Non-goals / assumptions:
- defending against a fully compromised local workstation
- safely running untrusted plugins
- multi-user isolation on a shared desktop session

## Hardening Guidance for Users

- Use a dedicated OS account for cluster operations where possible
- Keep Truss in `RO` mode except during intentional mutations
- Limit plugin usage to trusted, reviewed code
- Prefer least-privilege Kubernetes RBAC for stored contexts
- Keep release artifact verification (`KEYS`, checksums) in your install workflow

## Secrets and Credentials

Truss stores imported kubeconfigs and profile metadata in the encrypted vault. Session tokens used between renderer and backend are ephemeral per launch.

You are still responsible for:
- securing your workstation
- protecting GPG keys / hardware tokens (if using GPG mode)
- protecting any external credential helper configuration used by your kubeconfigs
