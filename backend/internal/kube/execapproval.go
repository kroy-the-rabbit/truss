package kube

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/kroy/truss/backend/internal/contextstore"
	"github.com/kroy/truss/backend/internal/execconsent"
)

// SensitiveAuth describes what a context's kubeconfig runs or reads locally.
type SensitiveAuth = execconsent.SensitiveAuth

// ErrFingerprintMismatch is returned by ApproveExec when the caller approved a
// configuration that is no longer the context's current one.
var ErrFingerprintMismatch = errors.New("fingerprint does not match the context's current exec configuration")

// ErrNothingToApprove is returned by ApproveExec for a context that neither
// runs a command nor references local files.
var ErrNothingToApprove = errors.New("context does not run a command or reference local files")

// ExtractSensitiveAuth returns the exec plugin, auth-provider and local file
// references of contextName in kubeconfigYAML (the current-context when
// contextName is empty), plus their approval fingerprint.
func ExtractSensitiveAuth(kubeconfigYAML, contextName string) (*SensitiveAuth, error) {
	return execconsent.Extract(kubeconfigYAML, contextName)
}

// ExecApproval reports a stored context's sensitive auth and whether its
// current fingerprint is approved. A context with nothing sensitive is
// reported as approved.
func (m *Manager) ExecApproval(contextName string) (*SensitiveAuth, bool, error) {
	entry, ok := m.store.GetContextEntry(contextName)
	if !ok {
		return nil, false, fmt.Errorf("context %q not found in store", contextName)
	}
	return execApprovalFor(entry)
}

func execApprovalFor(entry contextstore.ContextEntry) (*SensitiveAuth, bool, error) {
	sens, err := execconsent.Extract(entry.Kubeconfig, "")
	if err != nil {
		return nil, false, err
	}
	if !sens.IsSensitive() {
		return sens, true, nil
	}
	return sens, entry.ApprovedExecFingerprint != "" && sens.Fingerprint == entry.ApprovedExecFingerprint, nil
}

// checkExecApproval refuses (with a recorded EXEC_APPROVAL_REQUIRED health)
// when the entry runs a command or reads local files that are not approved.
func (m *Manager) checkExecApproval(contextName string, entry contextstore.ContextEntry) error {
	sens, approved, err := execApprovalFor(entry)
	if err != nil {
		return fmt.Errorf("parsing kubeconfig for context %q: %w", contextName, err)
	}
	if approved {
		return nil
	}
	return &AuthError{Health: m.recordExecApprovalRequired(contextName, sens)}
}

// CheckExecApproval is checkExecApproval for a stored context: it returns the
// context's sensitive auth and, when unapproved, an *AuthError (recording
// EXEC_APPROVAL_REQUIRED health). It never builds a client.
func (m *Manager) CheckExecApproval(contextName string) (*SensitiveAuth, error) {
	entry, ok := m.store.GetContextEntry(contextName)
	if !ok {
		return nil, fmt.Errorf("context %q not found in store", contextName)
	}
	sens, _, err := execApprovalFor(entry)
	if err != nil {
		return nil, err
	}
	return sens, m.checkExecApproval(contextName, entry)
}

func (m *Manager) recordExecApprovalRequired(contextName string, sens *SensitiveAuth) ContextHealth {
	t := m.tracker()
	t.mu.Lock()
	defer t.mu.Unlock()
	if prev, ok := t.health[contextName]; ok && prev.health.State == StateError &&
		prev.health.Kind == KindExecApprovalRequired && prev.health.Sensitive != nil &&
		prev.health.Sensitive.Fingerprint == sens.Fingerprint {
		return prev.health
	}
	t.gen++
	h := ContextHealth{
		Context:   contextName,
		State:     StateError,
		Kind:      KindExecApprovalRequired,
		Message:   describeKind(contextName, KindExecApprovalRequired),
		Since:     time.Now().UTC().Format(time.RFC3339),
		Sensitive: sens,
	}
	if sens.Exec != nil {
		h.PluginCommand = sens.Exec.CommandLine
	}
	t.health[contextName] = &healthState{health: h, gen: t.gen}
	t.notifyLocked(h)
	return h
}

// ApproveExec records fingerprint as approved for the context. It must equal
// the context's current fingerprint. Callers should then Reauth the context.
func (m *Manager) ApproveExec(contextName, fingerprint string) error {
	sens, _, err := m.ExecApproval(contextName)
	if err != nil {
		return err
	}
	if !sens.IsSensitive() {
		return ErrNothingToApprove
	}
	if !strings.EqualFold(strings.TrimSpace(fingerprint), sens.Fingerprint) {
		return ErrFingerprintMismatch
	}
	if err := m.store.SetApprovedExecFingerprint(contextName, sens.Fingerprint); err != nil {
		return err
	}
	m.InvalidateClient(contextName)
	return nil
}

// RevokeExec clears the context's approval and drops its client, so the next
// use reports EXEC_APPROVAL_REQUIRED instead of running the command.
func (m *Manager) RevokeExec(contextName string) error {
	if _, ok := m.store.GetContextEntry(contextName); !ok {
		return fmt.Errorf("context %q not found in store", contextName)
	}
	if err := m.store.SetApprovedExecFingerprint(contextName, ""); err != nil {
		return err
	}
	m.InvalidateClient(contextName)
	return nil
}
