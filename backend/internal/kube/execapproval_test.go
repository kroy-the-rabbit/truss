package kube

import (
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/kroy/truss/backend/internal/contextstore"
)

// approveStored records the stored context's current fingerprint as approved.
func approveStored(t *testing.T, s *contextstore.Store, name string) {
	t.Helper()
	entry, ok := s.GetContextEntry(name)
	if !ok {
		t.Fatalf("context %q not stored", name)
	}
	sens, err := ExtractSensitiveAuth(entry.Kubeconfig, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetApprovedExecFingerprint(name, sens.Fingerprint); err != nil {
		t.Fatal(err)
	}
}

func newUnapprovedExecManager(t *testing.T) (*Manager, *contextstore.Store, pluginFixture, string) {
	t.Helper()
	fx := newPluginFixture(t)
	fx.succeed(t)
	srv := versionServer(t, http.StatusOK)
	kc := execKubeconfig(srv.URL, fx.plugin, fx.dir)
	s := newEmptyStore(t)
	if err := s.Initialize("password", "", "correct-horse-battery-staple"); err != nil {
		t.Fatal(err)
	}
	if err := s.ImportContext("exec-ctx", "exec-ctx", kc); err != nil {
		t.Fatal(err)
	}
	return NewManager(s), s, fx, kc
}

func requireApprovalErr(t *testing.T, m *Manager, err error) {
	t.Helper()
	var ae *AuthError
	if !errors.As(err, &ae) || ae.Health.Kind != KindExecApprovalRequired {
		t.Fatalf("err = %v, want EXEC_APPROVAL_REQUIRED AuthError", err)
	}
	if Classify(err) != KindExecApprovalRequired {
		t.Fatalf("Classify = %q", Classify(err))
	}
	h := m.Health("exec-ctx")
	if h.State != StateError || h.Kind != KindExecApprovalRequired || h.Sensitive == nil || h.Sensitive.Exec == nil {
		t.Fatalf("health = %+v", h)
	}
}

func TestGetClientSetRefusesUnapprovedExec(t *testing.T) {
	m, _, fx, _ := newUnapprovedExecManager(t)

	_, err := m.GetClientSet("exec-ctx")
	requireApprovalErr(t, m, err)
	h := m.Health("exec-ctx")
	if h.Sensitive.Exec.Command != fx.plugin || strings.Join(h.Sensitive.Exec.EnvNames, ",") != "COUNT_FILE,FAIL_FILE" {
		t.Fatalf("sensitive = %+v", h.Sensitive.Exec)
	}
	if h.PluginCommand == "" || h.Sensitive.Fingerprint == "" || !strings.Contains(h.Message, "approve") {
		t.Fatalf("health = %+v", h)
	}

	// Breaker is open: Reauth still refuses and never runs the plugin.
	if got := m.Reauth("exec-ctx"); got.Kind != KindExecApprovalRequired {
		t.Fatalf("Reauth = %+v", got)
	}
	if _, err := m.GetClientSet("exec-ctx"); Classify(err) != KindExecApprovalRequired {
		t.Fatalf("second GetClientSet err = %v", err)
	}
	if fx.count() != 0 {
		t.Fatalf("plugin ran %d times without approval", fx.count())
	}
}

func TestApproveExecRejectsWrongFingerprintThenConnects(t *testing.T) {
	m, _, fx, kc := newUnapprovedExecManager(t)
	sens, err := ExtractSensitiveAuth(kc, "")
	if err != nil {
		t.Fatal(err)
	}

	if err := m.ApproveExec("exec-ctx", strings.Repeat("0", 64)); !errors.Is(err, ErrFingerprintMismatch) {
		t.Fatalf("ApproveExec(wrong) = %v", err)
	}
	if _, approved, _ := m.ExecApproval("exec-ctx"); approved {
		t.Fatal("wrong fingerprint was recorded")
	}
	if err := m.ApproveExec("exec-ctx", sens.Fingerprint); err != nil {
		t.Fatalf("ApproveExec: %v", err)
	}
	if h := m.Reauth("exec-ctx"); h.State != StateOK {
		t.Fatalf("Reauth after approve = %+v", h)
	}
	if fx.count() == 0 {
		t.Fatal("plugin never ran after approval")
	}
}

func TestChangedExecConfigNeedsReapproval(t *testing.T) {
	m, s, fx, kc := newUnapprovedExecManager(t)
	approveStored(t, s, "exec-ctx")
	if _, err := m.GetClientSet("exec-ctx"); err != nil {
		t.Fatalf("GetClientSet after approval: %v", err)
	}

	// Same name, different args: the old approval no longer matches.
	changed := strings.Replace(kc, "interactiveMode: Never", "interactiveMode: Never\n      args: [\"--evil\"]", 1)
	if err := s.ImportContext("exec-ctx", "exec-ctx", changed); err != nil {
		t.Fatal(err)
	}
	m.InvalidateClient("exec-ctx")
	_, err := m.GetClientSet("exec-ctx")
	requireApprovalErr(t, m, err)
	if got := m.Health("exec-ctx").Sensitive.Exec.Args; len(got) != 1 || got[0] != "--evil" {
		t.Fatalf("args = %v", got)
	}
	if fx.count() != 0 {
		t.Fatalf("plugin ran %d times", fx.count())
	}
}

func TestRevokeExec(t *testing.T) {
	m, s, _, _ := newUnapprovedExecManager(t)
	approveStored(t, s, "exec-ctx")
	if _, err := m.GetClientSet("exec-ctx"); err != nil {
		t.Fatal(err)
	}
	if err := m.RevokeExec("exec-ctx"); err != nil {
		t.Fatal(err)
	}
	if e, _ := s.GetContextEntry("exec-ctx"); e.ApprovedExecFingerprint != "" {
		t.Fatal("approval not cleared")
	}
	_, err := m.GetClientSet("exec-ctx")
	requireApprovalErr(t, m, err)
	if err := m.RevokeExec("missing"); err == nil {
		t.Fatal("RevokeExec(missing) should fail")
	}
}

func TestNonSensitiveContextNeedsNoApproval(t *testing.T) {
	m := NewManager(newInitializedStore(t))
	if _, err := m.GetClientSet("fake-ctx"); err != nil {
		t.Fatalf("GetClientSet: %v", err)
	}
	if err := m.ApproveExec("fake-ctx", "abc"); !errors.Is(err, ErrNothingToApprove) {
		t.Fatalf("ApproveExec = %v", err)
	}
}
