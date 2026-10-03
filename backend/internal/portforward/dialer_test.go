package portforward

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

func TestBuildDialerFromRestConfigDoesNotDial(t *testing.T) {
	cfg := &rest.Config{Host: "https://127.0.0.1:1/k8s/clusters/c-1", Timeout: 5 * time.Second}
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	d, err := BuildDialer(cfg, cs.CoreV1().RESTClient(), "ns", "p")
	if err != nil || d == nil {
		t.Fatalf("BuildDialer = %v, %v", d, err)
	}
	if cfg.Timeout != 5*time.Second {
		t.Fatal("BuildDialer mutated the shared rest config")
	}
	if _, err := BuildDialer(nil, nil, "ns", "p"); err == nil {
		t.Fatal("expected error for nil config")
	}
}

// The real dial path hits /api/v1/namespaces/<ns>/pods/<pod>/portforward on
// the context's server and reports a clean error when the upgrade is refused.
func TestDialKubeHitsPortForwardSubresource(t *testing.T) {
	var hits atomic.Int32
	var badPath atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.URL.Path != "/api/v1/namespaces/ns/pods/p/portforward" {
			badPath.Store(r.URL.Path)
		}
		http.Error(w, "upgrade refused", http.StatusForbidden)
	}))
	defer srv.Close()

	cfg := &rest.Config{Host: srv.URL}
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	_, err = dialKube(cfg, cs, "ns", "p")
	if err == nil || !strings.Contains(err.Error(), "connecting to pod ns/p") {
		t.Fatalf("err = %v", err)
	}
	if hits.Load() == 0 {
		t.Fatal("server never contacted")
	}
	if p := badPath.Load(); p != nil {
		t.Fatalf("unexpected path %v", p)
	}
}
