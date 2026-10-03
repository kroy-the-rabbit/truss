package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/kroy/truss/backend/internal/auth"
	"k8s.io/client-go/tools/clientcmd"
)

const testMainToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// Stored kubeconfig deliberately holds a second context/cluster/user that
// must not leak into the export.
const exportTestKubeconfig = `
apiVersion: v1
kind: Config
current-context: inner-ctx
contexts:
- name: inner-ctx
  context:
    cluster: prod-cluster
    user: prod-user
    namespace: apps
- name: other-ctx
  context:
    cluster: other-cluster
    user: other-user
clusters:
- name: prod-cluster
  cluster:
    server: https://127.0.0.1:6443
- name: other-cluster
  cluster:
    server: https://10.0.0.1:6443
users:
- name: prod-user
  user:
    token: prod-secret
- name: other-user
  user:
    token: other-secret
`

func newExportServer(t *testing.T) *Server {
	t.Helper()
	s := newSetupServer(t)
	initStore(t, s, "correct-horse-battery-staple")
	if err := s.store.ImportContext("vault-name", "Vault Name", exportTestKubeconfig); err != nil {
		t.Fatalf("ImportContext: %v", err)
	}
	s.SetMainToken(testMainToken)
	return s
}

func exportRequest(t *testing.T, ctx string, mainToken string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/contexts/export-kubeconfig", toJSONBody(t, map[string]string{"context": ctx}))
	req.Header.Set("Authorization", "Bearer bearer-token")
	if mainToken != "" {
		req.Header.Set(MainTokenHeader, mainToken)
	}
	return req
}

// serveFull routes through the real mux plus auth middleware, as Start does.
func serveFull(s *Server, req *http.Request) *httptest.ResponseRecorder {
	rr := httptest.NewRecorder()
	auth.Middleware("bearer-token")(s.newMux("bearer-token")).ServeHTTP(rr, req)
	return rr
}

func TestRequireMainTokenMissingHeader(t *testing.T) {
	s := newExportServer(t)
	rr := serveFull(s, exportRequest(t, "vault-name", ""))
	if rr.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rr.Code)
	}
	if strings.Contains(rr.Body.String(), "prod-secret") {
		t.Fatal("credentials leaked without main token")
	}
}

func TestRequireMainTokenWrongHeader(t *testing.T) {
	s := newExportServer(t)
	rr := serveFull(s, exportRequest(t, "vault-name", strings.Repeat("f", 64)))
	if rr.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rr.Code)
	}
}

func TestRequireMainTokenRightHeader(t *testing.T) {
	s := newExportServer(t)
	rr := serveFull(s, exportRequest(t, "vault-name", testMainToken))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body %s", rr.Code, rr.Body.String())
	}
}

func TestRequireMainTokenStillNeedsBearer(t *testing.T) {
	s := newExportServer(t)
	req := exportRequest(t, "vault-name", testMainToken)
	req.Header.Del("Authorization")
	rr := serveFull(s, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rr.Code)
	}
}

func TestRequireMainTokenDisabledWhenUnset(t *testing.T) {
	s := newExportServer(t)
	s.SetMainToken("")
	for _, tok := range []string{"", testMainToken, "x"} {
		rr := serveFull(s, exportRequest(t, "vault-name", tok))
		if rr.Code != http.StatusForbidden {
			t.Fatalf("token %q: status = %d, want 403", tok, rr.Code)
		}
	}
	// A server that never had SetMainToken called is disabled too.
	fresh := newSetupServer(t)
	rr := httptest.NewRecorder()
	fresh.requireMainToken(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })(rr, exportRequest(t, "x", ""))
	if rr.Code != http.StatusForbidden {
		t.Fatalf("unset token: status = %d, want 403", rr.Code)
	}
}

func TestExportRefusesWhenLocked(t *testing.T) {
	s := newExportServer(t)
	if err := s.store.Lock(); err != nil {
		t.Fatalf("Lock: %v", err)
	}
	called := false
	orig := exportClientCheck
	exportClientCheck = func(*Server, string) error { called = true; return nil }
	t.Cleanup(func() { exportClientCheck = orig })

	rr := serveFull(s, exportRequest(t, "vault-name", testMainToken))
	if rr.Code != http.StatusLocked {
		t.Fatalf("status = %d, want 423", rr.Code)
	}
	if called {
		t.Fatal("client check must not run while locked")
	}
}

func TestExportReturnsOnlyOneContext(t *testing.T) {
	s := newExportServer(t)
	rr := serveFull(s, exportRequest(t, "vault-name", testMainToken))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d; body %s", rr.Code, rr.Body.String())
	}
	if rr.Header().Get("Cache-Control") != "no-store" {
		t.Error("expected Cache-Control: no-store")
	}
	var resp struct {
		Kubeconfig string `json:"kubeconfig"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	cfg, err := clientcmd.Load([]byte(resp.Kubeconfig))
	if err != nil {
		t.Fatalf("exported kubeconfig does not parse: %v", err)
	}
	if cfg.CurrentContext != "vault-name" {
		t.Errorf("current-context = %q, want vault-name", cfg.CurrentContext)
	}
	if len(cfg.Contexts) != 1 || cfg.Contexts["vault-name"] == nil {
		t.Fatalf("contexts = %v", cfg.Contexts)
	}
	if ns := cfg.Contexts["vault-name"].Namespace; ns != "apps" {
		t.Errorf("namespace = %q, want apps", ns)
	}
	if len(cfg.Clusters) != 1 || cfg.Clusters["prod-cluster"] == nil {
		t.Fatalf("clusters = %v", cfg.Clusters)
	}
	if len(cfg.AuthInfos) != 1 || cfg.AuthInfos["prod-user"].Token != "prod-secret" {
		t.Fatalf("users = %v", cfg.AuthInfos)
	}
	if strings.Contains(resp.Kubeconfig, "other-secret") || strings.Contains(resp.Kubeconfig, "10.0.0.1") {
		t.Fatal("export leaked another context's data")
	}
}

func TestExportPropagatesClientSetError(t *testing.T) {
	s := newExportServer(t)
	var gotName string
	orig := exportClientCheck
	exportClientCheck = func(_ *Server, name string) error {
		gotName = name
		return errors.New("exec plugin not approved")
	}
	t.Cleanup(func() { exportClientCheck = orig })

	rr := serveFull(s, exportRequest(t, "vault-name", testMainToken))
	if rr.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rr.Code)
	}
	if gotName != "vault-name" {
		t.Errorf("client check got %q", gotName)
	}
	if !strings.Contains(rr.Body.String(), "exec plugin not approved") {
		t.Errorf("body = %s", rr.Body.String())
	}
	if strings.Contains(rr.Body.String(), "prod-secret") {
		t.Fatal("credentials returned despite client error")
	}
}

func TestExportRealClientSetErrorForUnknownContext(t *testing.T) {
	s := newExportServer(t)
	rr := serveFull(s, exportRequest(t, "no-such-context", testMainToken))
	if rr.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body %s", rr.Code, rr.Body.String())
	}
}

func TestExportRejectsBadRequests(t *testing.T) {
	s := newExportServer(t)
	rr := serveFull(s, exportRequest(t, "  ", testMainToken))
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("empty context: status = %d, want 400", rr.Code)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/contexts/export-kubeconfig", nil)
	req.Header.Set("Authorization", "Bearer bearer-token")
	req.Header.Set(MainTokenHeader, testMainToken)
	rr = serveFull(s, req)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET: status = %d, want 405", rr.Code)
	}
}
