package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"connectrpc.com/connect"
	disc "github.com/kroy/truss/backend/internal/discovery"
	"github.com/kroy/truss/backend/internal/kube"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"

	pb "github.com/kroy/truss/backend/api/gen/go/truss/v1"
)

const healthTestPlugin = `#!/bin/sh
if [ -e "$FAIL_FILE" ]; then
  echo "please run: login-now" >&2
  exit 1
fi
printf '{"apiVersion":"client.authentication.k8s.io/v1beta1","kind":"ExecCredential","status":{"token":"t"}}'
`

// newHealthTestServer returns a server with one exec-auth context ("exec")
// whose plugin fails until the returned fix func is called.
func newHealthTestServer(t *testing.T) (*Server, func()) {
	t.Helper()
	s := newSetupServer(t)
	initStore(t, s, "password-123")

	api := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"major":"1","minor":"37","gitVersion":"v1.37.0"}`))
	}))
	t.Cleanup(api.Close)

	dir := t.TempDir()
	plugin := filepath.Join(dir, "plugin")
	failFile := filepath.Join(dir, "fail")
	if err := os.WriteFile(plugin, []byte(healthTestPlugin), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(failFile, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	kc := fmt.Sprintf(`apiVersion: v1
kind: Config
current-context: exec
clusters:
- name: c
  cluster:
    server: %s
    insecure-skip-tls-verify: true
contexts:
- name: exec
  context: {cluster: c, user: u}
users:
- name: u
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: %s
      interactiveMode: Never
      env:
      - {name: FAIL_FILE, value: %s}
`, api.URL, plugin, failFile)
	if err := s.store.ImportContext("exec", "exec", kc); err != nil {
		t.Fatal(err)
	}
	s.watchCache = newHealthAwareWatchCache(s.kubeMgr)
	s.discoveryCache = disc.NewCache()
	return s, func() {
		if err := os.Remove(failFile); err != nil {
			t.Fatal(err)
		}
	}
}

func decodeHealth(t *testing.T, body []byte) kube.ContextHealth {
	t.Helper()
	var h kube.ContextHealth
	if err := json.Unmarshal(body, &h); err != nil {
		t.Fatalf("decode %s: %v", body, err)
	}
	return h
}

func TestContextHealthHandlers(t *testing.T) {
	s, fix := newHealthTestServer(t)

	// Unknown before anything is recorded.
	rec := httptest.NewRecorder()
	s.handleContextHealth(rec, httptest.NewRequest(http.MethodGet, "/api/context-health?context=exec", nil))
	if h := decodeHealth(t, rec.Body.Bytes()); rec.Code != 200 || h.State != "unknown" || h.Context != "exec" || h.Kind != "" {
		t.Fatalf("initial health = %d %s", rec.Code, rec.Body)
	}

	// Raw JSON uses the contract's snake_case keys.
	var raw map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &raw)
	for _, k := range []string{"context", "state", "kind", "message", "plugin_command", "suggested_command", "stderr", "since"} {
		if _, ok := raw[k]; !ok {
			t.Errorf("missing key %q in %s", k, rec.Body)
		}
	}

	// Reauth while the plugin still fails: 200 with error state.
	rec = httptest.NewRecorder()
	s.handleContextReauth(rec, httptest.NewRequest(http.MethodPost, "/api/contexts/reauth", toJSONBody(t, map[string]string{"context": "exec"})))
	h := decodeHealth(t, rec.Body.Bytes())
	if rec.Code != 200 || h.State != "error" || h.Kind != kube.KindAuthRequired || h.PluginCommand == "" || h.Since == "" {
		t.Fatalf("reauth (failing) = %d %s", rec.Code, rec.Body)
	}

	// /ws/watch is rejected with 401 + kind while the breaker is open.
	rec = httptest.NewRecorder()
	s.handleWatchWS("")(rec, httptest.NewRequest(http.MethodGet, "/ws/watch?context=exec", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("watch status = %d, want 401", rec.Code)
	}
	var wsBody map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &wsBody)
	if wsBody["kind"] != "AUTH_REQUIRED" || wsBody["error"] == "" {
		t.Fatalf("watch body = %s", rec.Body)
	}

	// Connect RPCs report Unauthenticated without re-running the plugin.
	_, err := s.ListNamespaces(t.Context(), connect.NewRequest(&pb.ListNamespacesRequest{Context: "exec"}))
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("ListNamespaces code = %v (%v)", connect.CodeOf(err), err)
	}

	// List-all form.
	rec = httptest.NewRecorder()
	s.handleContextHealth(rec, httptest.NewRequest(http.MethodGet, "/api/context-health", nil))
	var all struct {
		Contexts []kube.ContextHealth `json:"contexts"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &all); err != nil || len(all.Contexts) != 1 || all.Contexts[0].Context != "exec" {
		t.Fatalf("all = %s (%v)", rec.Body, err)
	}

	// Fix credentials and reauth: ok.
	fix()
	rec = httptest.NewRecorder()
	s.handleContextReauth(rec, httptest.NewRequest(http.MethodPost, "/api/contexts/reauth", toJSONBody(t, map[string]string{"context": "exec"})))
	h = decodeHealth(t, rec.Body.Bytes())
	if rec.Code != 200 || h.State != "ok" || h.Kind != "" {
		t.Fatalf("reauth (fixed) = %d %s", rec.Code, rec.Body)
	}
}

func TestContextReauthValidation(t *testing.T) {
	s, _ := newHealthTestServer(t)
	tests := []struct {
		name   string
		method string
		body   string
		want   int
	}{
		{"wrong method", http.MethodGet, "", http.StatusMethodNotAllowed},
		{"bad json", http.MethodPost, "{", http.StatusBadRequest},
		{"missing context", http.MethodPost, `{}`, http.StatusBadRequest},
		{"unknown context", http.MethodPost, `{"context":"nope"}`, http.StatusNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			s.handleContextReauth(rec, httptest.NewRequest(tt.method, "/api/contexts/reauth", strings.NewReader(tt.body)))
			if rec.Code != tt.want {
				t.Fatalf("code = %d, want %d (%s)", rec.Code, tt.want, rec.Body)
			}
		})
	}
	rec := httptest.NewRecorder()
	s.handleContextHealth(rec, httptest.NewRequest(http.MethodPost, "/api/context-health", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("context-health POST = %d", rec.Code)
	}
}

func TestToConnectErrorMapping(t *testing.T) {
	s := newSetupServer(t)
	gr := schema.GroupResource{Resource: "pods"}
	wrapURL := func(err error) error { return &url.Error{Op: "Get", URL: "https://x/api", Err: err} }
	tests := []struct {
		name string
		err  error
		want connect.Code
	}{
		{"auth required", wrapURL(errors.New("getting credentials: exec: executable gke-gcloud-auth-plugin failed with exit code 1")), connect.CodeUnauthenticated},
		{"plugin missing", wrapURL(errors.New("getting credentials: exec: executable kubelogin not found")), connect.CodeUnauthenticated},
		{"interactive", wrapURL(errors.New("getting credentials: exec plugin cannot support interactive mode: standard input is not a terminal")), connect.CodeUnauthenticated},
		{"rejected", apierrors.NewUnauthorized("Unauthorized"), connect.CodeUnauthenticated},
		{"breaker", &kube.AuthError{Health: kube.ContextHealth{Kind: kube.KindAuthRejected, Message: "m"}}, connect.CodeUnauthenticated},
		{"forbidden", fmt.Errorf("listing resources: %w", apierrors.NewForbidden(gr, "", errors.New("no"))), connect.CodePermissionDenied},
		{"unreachable", wrapURL(errors.New("dial tcp 10.0.0.1:443: connect: connection refused")), connect.CodeUnavailable},
		{"tls", wrapURL(errors.New("tls: failed to verify certificate: x509: certificate signed by unknown authority")), connect.CodeUnavailable},
		{"unknown", errors.New("boom"), connect.CodeInternal},
		{"not found stays internal", apierrors.NewNotFound(gr, "x"), connect.CodeInternal},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := s.toConnectError("ctx-"+tt.name, tt.err)
			if got := connect.CodeOf(err); got != tt.want {
				t.Fatalf("code = %v, want %v (%v)", got, tt.want, err)
			}
			if err.Error() == "" {
				t.Fatal("empty message")
			}
		})
	}
	if s.toConnectError("x", nil) != nil {
		t.Fatal("nil error should map to nil")
	}
	if got := connect.CodeOf(s.toConnectErrorDefault("x", apierrors.NewNotFound(gr, "x"), connect.CodeNotFound)); got != connect.CodeNotFound {
		t.Fatalf("fallback code = %v", got)
	}
	// FORBIDDEN is not recorded against the context by toConnectError.
	if h := s.kubeMgr.Health("ctx-forbidden"); h.State != kube.StateUnknown {
		t.Fatalf("forbidden should not be recorded: %+v", h)
	}
	if h := s.kubeMgr.Health("ctx-unreachable"); h.Kind != kube.KindUnreachable {
		t.Fatalf("unreachable should be recorded: %+v", h)
	}
}

func TestHealthWatchMessage(t *testing.T) {
	b := healthWatchMessage(kube.ContextHealth{Context: "a", State: "error", Kind: kube.KindTLS})
	var msg struct {
		Type   string             `json:"type"`
		Health kube.ContextHealth `json:"health"`
	}
	if err := json.Unmarshal(b, &msg); err != nil || msg.Type != "health" || msg.Health.Kind != kube.KindTLS {
		t.Fatalf("msg = %s", b)
	}
}
