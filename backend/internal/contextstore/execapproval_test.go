package contextstore

import (
	"strings"
	"testing"

	"github.com/kroy/truss/backend/internal/execconsent"
)

const migrationExecKC = `apiVersion: v1
kind: Config
current-context: e
clusters:
- name: c
  cluster: {server: https://example.invalid}
contexts:
- name: e
  context: {cluster: c, user: u}
users:
- name: u
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: gke-gcloud-auth-plugin
`

const migrationPlainKC = `apiVersion: v1
kind: Config
current-context: p
clusters:
- name: c
  cluster: {server: https://example.invalid}
contexts:
- name: p
  context: {cluster: c, user: u}
users:
- name: u
  user: {token: abc}
`

const migrationPassword = "correct-horse-battery"

func reopen(t *testing.T) *Store {
	t.Helper()
	s, err := New()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Unlock(migrationPassword); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestExecApprovalMigrationGrandfathersOnce(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("XDG_CONFIG_HOME", tmp)

	s, err := New()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Initialize("password", "", migrationPassword); err != nil {
		t.Fatal(err)
	}
	for name, kc := range map[string]string{"old-exec": migrationExecKC, "old-plain": migrationPlainKC} {
		if err := s.ImportContext(name, name, kc); err != nil {
			t.Fatal(err)
		}
	}
	// Simulate a store written before exec approval existed.
	s.mu.Lock()
	s.execApprovalMigrated = false
	if err := s.saveLocked(); err != nil {
		t.Fatal(err)
	}
	s.mu.Unlock()

	s = reopen(t)
	want, _ := execconsent.Fingerprint(migrationExecKC)
	if e, _ := s.GetContextEntry("old-exec"); e.ApprovedExecFingerprint != want || want == "" {
		t.Fatalf("old-exec fingerprint = %q, want %q", e.ApprovedExecFingerprint, want)
	}
	if e, _ := s.GetContextEntry("old-plain"); e.ApprovedExecFingerprint != "" {
		t.Fatalf("plain context got fingerprint %q", e.ApprovedExecFingerprint)
	}

	// Contexts imported after the migration are never grandfathered.
	newKC := strings.Replace(migrationExecKC, "gke-gcloud-auth-plugin", "sh", 1)
	if err := s.ImportContext("new-exec", "new-exec", newKC); err != nil {
		t.Fatal(err)
	}
	s = reopen(t)
	if e, _ := s.GetContextEntry("new-exec"); e.ApprovedExecFingerprint != "" {
		t.Fatalf("new-exec was grandfathered: %q", e.ApprovedExecFingerprint)
	}
	if e, _ := s.GetContextEntry("old-exec"); e.ApprovedExecFingerprint != want {
		t.Fatal("grandfathered approval was not persisted")
	}
}

func TestImportKeepsApprovalAndRevokeClears(t *testing.T) {
	s := newTestStore(t)
	if err := s.Initialize("password", "", migrationPassword); err != nil {
		t.Fatal(err)
	}
	if err := s.ImportContext("e", "e", migrationExecKC); err != nil {
		t.Fatal(err)
	}
	if err := s.SetApprovedExecFingerprint("e", "abc"); err != nil {
		t.Fatal(err)
	}
	if err := s.ImportContext("e", "e", migrationExecKC); err != nil {
		t.Fatal(err)
	}
	if e, _ := s.GetContextEntry("e"); e.ApprovedExecFingerprint != "abc" {
		t.Fatalf("re-import dropped approval: %q", e.ApprovedExecFingerprint)
	}
	if err := s.SetApprovedExecFingerprint("e", ""); err != nil {
		t.Fatal(err)
	}
	if e, _ := s.GetContextEntry("e"); e.ApprovedExecFingerprint != "" {
		t.Fatal("revoke did not clear approval")
	}
	if err := s.SetApprovedExecFingerprint("missing", "x"); err == nil {
		t.Fatal("expected error for missing context")
	}
}
