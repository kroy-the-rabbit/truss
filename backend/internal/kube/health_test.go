package kube

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kroy/truss/backend/internal/contextstore"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

// fakePluginScript counts invocations in $COUNT_FILE, writes to stderr and
// fails unless $FAIL_FILE has been removed, in which case it emits a token.
const fakePluginScript = `#!/bin/sh
echo x >> "$COUNT_FILE"
if [ -e "$FAIL_FILE" ]; then
  echo "ERROR: Reauthentication required. info=$KUBERNETES_EXEC_INFO" >&2
  exit 1
fi
printf '{"apiVersion":"client.authentication.k8s.io/v1beta1","kind":"ExecCredential","status":{"token":"good-token"}}'
`

func execKubeconfig(server, plugin, dir string) string {
	return fmt.Sprintf(`
apiVersion: v1
kind: Config
current-context: exec-ctx
clusters:
- name: c
  cluster:
    server: %s
    insecure-skip-tls-verify: true
contexts:
- name: exec-ctx
  context:
    cluster: c
    user: u
users:
- name: u
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: %s
      interactiveMode: Never
      env:
      - name: COUNT_FILE
        value: %s
      - name: FAIL_FILE
        value: %s
`, server, plugin, filepath.Join(dir, "count"), filepath.Join(dir, "fail"))
}

type pluginFixture struct {
	dir    string
	plugin string
}

func newPluginFixture(t *testing.T) pluginFixture {
	t.Helper()
	dir := t.TempDir()
	plugin := filepath.Join(dir, "fake-auth-plugin")
	if err := os.WriteFile(plugin, []byte(fakePluginScript), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "fail"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	return pluginFixture{dir: dir, plugin: plugin}
}

func (f pluginFixture) count() int {
	b, _ := os.ReadFile(filepath.Join(f.dir, "count"))
	return strings.Count(string(b), "x")
}

func (f pluginFixture) succeed(t *testing.T) {
	t.Helper()
	if err := os.Remove(filepath.Join(f.dir, "fail")); err != nil {
		t.Fatal(err)
	}
}

func newStoreWith(t *testing.T, name, kubeconfig string) *contextstore.Store {
	t.Helper()
	s := newEmptyStore(t)
	if err := s.Initialize("password", "", "correct-horse-battery-staple"); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	if err := s.ImportContext(name, name, kubeconfig); err != nil {
		t.Fatalf("ImportContext: %v", err)
	}
	approveStored(t, s, name)
	return s
}

func versionServer(t *testing.T, status int) *httptest.Server {
	t.Helper()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		if status == http.StatusOK {
			_, _ = w.Write([]byte(`{"major":"1","minor":"37","gitVersion":"v1.37.0"}`))
			return
		}
		_, _ = fmt.Fprintf(w, `{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Unauthorized","code":%d}`, status)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestBreakerShortCircuitsPluginUntilReauth(t *testing.T) {
	fx := newPluginFixture(t)
	srv := versionServer(t, http.StatusOK)
	store := newStoreWith(t, "exec-ctx", execKubeconfig(srv.URL, fx.plugin, fx.dir))
	m := NewManager(store)

	updates, cancel := m.SubscribeHealth()
	defer cancel()

	cs, err := m.GetClientSet("exec-ctx")
	if err != nil {
		t.Fatalf("GetClientSet: %v", err)
	}
	_, err = cs.Discovery.ServerVersion()
	if got := Classify(err); got != KindAuthRequired {
		t.Fatalf("Classify(%v) = %q, want AUTH_REQUIRED (plugin runs=%d, health=%+v)", err, got, fx.count(), m.Health("exec-ctx"))
	}

	// Transition triggers exactly one stderr-capture run of the plugin.
	waitFor(t, "stderr capture", func() bool { return m.Health("exec-ctx").Stderr != "" })
	h := m.Health("exec-ctx")
	if h.State != StateError || h.Kind != KindAuthRequired {
		t.Fatalf("health = %+v", h)
	}
	if !strings.Contains(h.Stderr, "Reauthentication required") || !strings.Contains(h.Stderr, `"interactive":false`) {
		t.Fatalf("stderr = %q", h.Stderr)
	}
	if !strings.Contains(h.Stderr, `"apiVersion":"client.authentication.k8s.io/v1beta1"`) {
		t.Fatalf("exec info apiVersion missing from %q", h.Stderr)
	}
	if h.PluginCommand != fx.plugin || h.SuggestedCommand != fx.plugin {
		t.Fatalf("plugin/suggested = %q / %q", h.PluginCommand, h.SuggestedCommand)
	}
	if h.Since == "" {
		t.Fatal("since should be set")
	}
	if c := fx.count(); c != 2 {
		t.Fatalf("plugin count after first failure = %d, want 2 (client-go + capture)", c)
	}

	// Further calls are short-circuited without invoking the plugin.
	for i := 0; i < 5; i++ {
		if _, err := m.GetClientSet("exec-ctx"); Classify(err) != KindAuthRequired {
			t.Fatalf("GetClientSet while tripped: %v", err)
		}
		var ae *AuthError
		if _, err := cs.Discovery.ServerVersion(); !errors.As(err, &ae) {
			t.Fatalf("existing client should hit breaker, got %v", err)
		}
	}
	if !m.InErrorState("exec-ctx") {
		t.Fatal("InErrorState should be true")
	}
	if c := fx.count(); c != 2 {
		t.Fatalf("plugin count after short-circuited calls = %d, want 2", c)
	}

	// Health transitions were published.
	select {
	case got := <-updates:
		if got.Context != "exec-ctx" || got.Kind != KindAuthRequired {
			t.Fatalf("update = %+v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("no health update published")
	}

	// Reauth while still failing: state stays error.
	h = m.Reauth("exec-ctx")
	if h.State != StateError || h.Kind != KindAuthRequired {
		t.Fatalf("reauth (still failing) = %+v", h)
	}

	// Fix credentials; reauth clears the breaker.
	fx.succeed(t)
	h = m.Reauth("exec-ctx")
	if h.State != StateOK || h.Kind != KindNone || h.Since == "" {
		t.Fatalf("reauth (fixed) = %+v", h)
	}
	if _, err := m.GetClientSet("exec-ctx"); err != nil {
		t.Fatalf("GetClientSet after reauth: %v", err)
	}
	if m.InErrorState("exec-ctx") {
		t.Fatal("InErrorState should be false after reauth")
	}
}

func TestBreakerTripsOn401AndSuccessClearsNonAuth(t *testing.T) {
	srv := versionServer(t, http.StatusUnauthorized)
	kc := strings.Replace(fakeKubeconfig, "https://localhost:16443", srv.URL, 1)
	m := NewManager(newStoreWith(t, "tok", kc))

	cs, err := m.GetClientSet("tok")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := cs.Discovery.ServerVersion(); Classify(err) != KindAuthRejected {
		t.Fatalf("want AUTH_REJECTED, got %v", err)
	}
	h := m.Health("tok")
	if h.State != StateError || h.Kind != KindAuthRejected {
		t.Fatalf("health = %+v", h)
	}
	if h.PluginCommand != "" || h.SuggestedCommand != "" {
		t.Fatalf("non-exec context should have no plugin command: %+v", h)
	}
	if _, err := m.GetClientSet("tok"); Classify(err) != KindAuthRejected {
		t.Fatalf("breaker should be open, got %v", err)
	}

	// UNREACHABLE records but does not trip the breaker; success clears it.
	m.ResetHealth("tok")
	m.RecordError("tok", urlErr(errors.New("dial tcp 10.0.0.1:443: connect: connection refused")))
	if h := m.Health("tok"); h.Kind != KindUnreachable || h.State != StateError {
		t.Fatalf("health = %+v", h)
	}
	if _, err := m.GetClientSet("tok"); err != nil {
		t.Fatalf("UNREACHABLE must not trip breaker: %v", err)
	}
	m.RecordSuccess("tok")
	if h := m.Health("tok"); h.State != StateOK || h.Kind != KindNone {
		t.Fatalf("health after success = %+v", h)
	}
	// UNKNOWN errors are not recorded.
	m.RecordError("tok", errors.New("something odd"))
	if h := m.Health("tok"); h.State != StateOK {
		t.Fatalf("UNKNOWN should not change state: %+v", h)
	}
}

func TestHealthUnknownAndAll(t *testing.T) {
	m := NewManager(newInitializedStore(t))
	if h := m.Health("nope"); h.State != StateUnknown || h.Context != "nope" {
		t.Fatalf("health = %+v", h)
	}
	m.RecordSuccess("b")
	m.RecordError("a", apiForbidden())
	all := m.AllHealth()
	if len(all) != 2 || all[0].Context != "a" || all[0].Kind != KindForbidden || all[1].State != StateOK {
		t.Fatalf("all = %+v", all)
	}
	if _, err := m.GetClientSet("fake-ctx"); err != nil {
		t.Fatalf("GetClientSet: %v", err)
	}
	m.ClearAllClients()
	if len(m.AllHealth()) != 0 {
		t.Fatal("ClearAllClients should reset health")
	}
}

func TestRunPluginForStderrCapsOutput(t *testing.T) {
	dir := t.TempDir()
	plugin := filepath.Join(dir, "noisy")
	script := "#!/bin/sh\nhead -c 10000 /dev/zero | tr '\\0' 'e' >&2\nexit 1\n"
	if err := os.WriteFile(plugin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	out := RunPluginForStderr(&clientcmdapi.ExecConfig{Command: plugin, APIVersion: "client.authentication.k8s.io/v1"})
	if len(out) != stderrCaptureLimit {
		t.Fatalf("len(stderr) = %d, want %d", len(out), stderrCaptureLimit)
	}
}

func apiForbidden() error {
	return apierrors.NewForbidden(schema.GroupResource{Resource: "namespaces"}, "", errors.New("rbac"))
}
