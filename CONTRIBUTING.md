# Contributing to Truss

Thanks for contributing to Truss.

This project is in the `1.0.x` production line, so changes should preserve operator safety, backwards compatibility, and release quality.

## Before You Open a PR

- Check for an existing issue or discussion.
- Keep changes scoped (feature work, refactor, docs, or build/CI in separate PRs when possible).
- For UI changes, include screenshots or a short video.
- For behavioral changes, include tests or explain why tests are not practical.

## Reporting Issues

Open a GitHub issue and include:
- expected behavior
- actual behavior
- reproduction steps
- Truss version
- OS / architecture
- Kubernetes version and cluster type (if relevant)
- whether the issue reproduces with `kubectl`

For sensitive vulnerabilities, use [SECURITY.md](SECURITY.md) instead of a public issue.

## Development Setup

See [README.md](README.md) for full setup and build instructions.

### Required Tools

- Node.js 22+
- Go 1.25+
- `buf` CLI
- `make`

### Project Structure

```text
backend/                 Go daemon (trussd) + ConnectRPC services
  cmd/trussd/            Entry point
  internal/              Server, kube access, discovery, auth, watch cache, etc.
  api/proto/             Protobuf definitions
  api/gen/               Generated Go code

app/                     Electron frontend
  src/main/              Electron main process + daemon launcher
  src/main/preload.ts    Preload bridge
  src/renderer/          React app
    components/          UI components
    panes/               Top-level panes
    state/               Zustand + React Query hooks
    api/                 Generated TypeScript client stubs
    plugins/             Plugin APIs and runtime
```

## PR Checklist

Before opening a PR, run the checks relevant to your change:

```bash
# backend
cd backend && go test ./...

# frontend unit tests (includes modal wrapper guard)
cd app && npm ci && npm run test

# frontend smoke tests (recommended for UI/navigation changes)
cd app && npm run test:e2e

# production build
cd app && npm run build
```

If you cannot run a command locally (platform or environment limitation), note it in the PR description.

## Engineering Expectations

### Safety and Security

- Preserve read-only (`RO`) protections by default.
- Do not introduce bypasses for mutating actions without explicit UX gating.
- Treat plugin APIs as privileged surfaces; minimize new capabilities and document tradeoffs.
- Keep localhost auth and IPC boundaries tight.

### Backwards Compatibility (`1.x`)

For stable releases:
- Avoid breaking plugin API behavior without a deprecation path.
- Avoid vault format changes unless necessary.
- Document user-visible changes in behavior (especially safety/security changes).

### Testing

Prefer targeted tests for changes in:
- query/state behavior
- keyboard navigation and focus behavior
- IPC boundary/security-sensitive flows
- renderer regressions (Playwright smoke coverage where practical)

## Code Style

- Go: `gofmt`
- TypeScript/React: follow existing patterns in the touched file
- Keep diffs focused and avoid unrelated formatting churn
- Add comments only where the logic is non-obvious

## Commit Messages

- Imperative mood (`Add`, `Fix`, `Refactor`)
- Concise summary on the first line (prefer < 72 chars)
- Explain `why` in the body when the change is non-trivial
- Signed commits/tags are preferred for release work

## Contributor License Agreement

By submitting a pull request, you agree to the terms of the [Contributor License Agreement](CLA.md). Contributions are accepted under the Apache License 2.0.

## Versioning and Releases

Truss follows [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`).

### Version bump guidance

- `MAJOR`: breaking changes (vault format migrations, plugin API breaks, removed workflows)
- `MINOR`: backwards-compatible features and user-visible enhancements
- `PATCH`: fixes, security patches, CI/build fixes, docs updates

### Pre-release tags

- `-alpha.N`: early/incomplete
- `-beta.N`: feature-complete, stabilization in progress
- `-rc.N`: release candidate

### Tagging and release CI

- Use signed tags where possible (see `KEYS`)
- Tag format: `vMAJOR.MINOR.PATCH` or SemVer pre-release (`v1.2.0-rc.1`)
- Pushing a `v*` tag triggers the release workflow

## Code of Conduct

Be respectful, direct, and constructive.
