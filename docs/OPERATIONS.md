# Operations and Troubleshooting

This guide covers day-2 operation of Truss on production workstations.

## Operating Model

Truss is a desktop application with a local backend daemon (`trussd`) bound to `127.0.0.1` on an ephemeral port. It communicates with your clusters using your locally stored kubeconfig credentials from the encrypted vault.

Operational implications:
- No cluster-side components are installed by Truss.
- Cluster access and behavior depend on the selected context's credentials and RBAC.
- Plugin code runs with privileged access in the app process model (use trusted plugins only).

## Recommended Safety Practices

- Keep Truss in `RO` mode unless you are actively performing a mutation.
- Use separate profiles for production vs non-production clusters.
- Label profiles with distinct colors for fast visual confirmation.
- Validate active context/namespace before YAML apply, delete, restart, scale, or Helm operations.
- Restrict plugin usage to reviewed/trusted code.

## Common Issues

### Resources appear blank or incomplete after connecting to a context

Likely cause: initial watch/discovery cache warm-up.

What to expect:
- On large clusters or CRD-heavy clusters, discovery and cache warm-up may take several seconds.
- Truss shows discovery/loading indicators and cache warm-up hints in overview/navigation.
- Search and overview may be incomplete briefly while background indexing completes.

What to do:
- Wait 10–30 seconds on large clusters.
- Retry the view after the cache-warm indication clears.
- Confirm the cluster/API is reachable with `kubectl get ns`.

### Resource list is empty and you expected results

Possible causes:
- Wrong namespace selected
- Name filter active
- RBAC denies `list` on that resource

Checks:
- Clear the resource filter.
- Switch namespace to `All namespaces` if appropriate.
- Run `kubectl auth can-i list <resource> [-n <namespace>]`.

Truss now shows RBAC-oriented hints in empty/error states for common denial cases.

### Discovery fails or the tree shows no kinds

Likely cause: discovery API access is blocked by RBAC or cluster auth failed.

Checks:
- Confirm the context works in `kubectl`: `kubectl --context <ctx> api-resources`
- Verify required credential helper is present on `PATH`
- Check Truss **Preferences -> Exec PATH hints** if the helper is installed outside the default app environment

### `exec plugin` credential helper not found

Truss launches Kubernetes auth helper commands from the desktop app environment, which may differ from your shell.

Fixes:
- Install the helper locally
- Add its directory to **Preferences -> Exec PATH hints**
- Restart Truss after changing PATH hints if necessary

Examples:
- `gke-gcloud-auth-plugin`
- `aws` / `aws-iam-authenticator`
- `kubelogin`

### Port-forward stopped unexpectedly after locking the vault

This is expected behavior in current `1.0.x` builds.

Why:
- Locking the vault now stops active port-forward sessions and prevents starting/opening new port-forwards until unlock.
- This preserves the lock model consistently across session windows.

### File transfer fails inside a container

Truss file transfer uses `sh` and common POSIX utilities inside the container.

Not supported:
- distroless images (no shell)
- containers missing required shell utilities

Workaround:
- Use `kubectl cp` or a debug sidecar/toolbox container

### App feels slow on a large cluster

Normal sources of latency:
- Initial discovery of many API groups/CRDs
- Initial informer/watch cache warm-up
- Background search indexing

Mitigations:
- Let initial warm-up complete before wide navigation/search
- Narrow namespaces when possible
- Avoid extremely broad filters during warm-up
- Keep Truss running (discovery cache now persists across restarts)

### Vault cannot be unlocked or startup shows a store error

Possible causes:
- Wrong password
- Missing/unavailable GPG key/agent
- Corrupted `contexts.enc`
- Incompatible file content

Recovery path:
- Back up `~/.config/truss/contexts.enc` (or `%AppData%\\truss\\contexts.enc`)
- Use the in-app reset option on the error screen if needed
- Re-import contexts after reset

## Backups and Recovery

Recommended backups (especially before upgrades or workstation changes):
- `contexts.enc`
- `preferences.json`
- `plugins/` (if using local plugins)
- `user.css` (if customized)

Linux/macOS location:
- `~/.config/truss/`

Windows location:
- `%AppData%\\truss\\`

## Logging and Diagnostics

Useful diagnostics when reporting bugs:
- OS and architecture
- Truss version (`Help` / app info)
- Kubernetes version(s)
- Cluster type (EKS/GKE/AKS/on-prem/etc.)
- Whether the issue reproduces in `kubectl`
- Exact resource kind / namespace involved
- Screenshot or error text from the UI

For bug reporting guidance, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Security Notes for Operators

- Truss is intended for a trusted local workstation, not shared multi-user desktops.
- Plugins are privileged; review plugin code before enabling.
- Prefer keeping production credentials scoped and RBAC-limited.
- Use profile separation to reduce accidental cross-environment actions.

See [SECURITY.md](../SECURITY.md) for the formal security policy and disclosure instructions.
