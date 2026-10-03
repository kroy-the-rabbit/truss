package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/httpstream"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"

	"github.com/kroy/truss/backend/internal/portforward"
)

// newPortForwardTestServer wires a server whose forwards resolve against a
// fake clientset and whose dials block until the test ends (status
// "starting"), so no real API server is needed.
func newPortForwardTestServer(t *testing.T) *Server {
	t.Helper()
	s := newSetupServer(t)
	initStore(t, s, "pw-123456")
	client := fake.NewClientset(&corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "web-0", Namespace: "ns"},
		Status:     corev1.PodStatus{Phase: corev1.PodRunning},
	})
	block := make(chan struct{})
	t.Cleanup(func() { close(block) })
	s.portForwards = portforward.NewManager(
		func(string) (kubernetes.Interface, *rest.Config, error) { return client, &rest.Config{}, nil },
		func(*rest.Config, kubernetes.Interface, string, string) (httpstream.Connection, error) {
			<-block
			return nil, errors.New("test over")
		},
	)
	t.Cleanup(s.stopAllPortForwards)
	return s
}

func startForward(t *testing.T, s *Server, ctx string) portforward.Info {
	t.Helper()
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/portforward/start", toJSONBody(t, map[string]any{
		"context": ctx, "namespace": "ns", "kind": "pod", "name": "web-0", "remote_port": 8080, "local_port": 0,
	}))
	s.handlePortForwardStart(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("start: %d %s", rr.Code, rr.Body.String())
	}
	var info portforward.Info
	if err := json.Unmarshal(rr.Body.Bytes(), &info); err != nil {
		t.Fatal(err)
	}
	return info
}

func listForwards(t *testing.T, s *Server) []map[string]any {
	t.Helper()
	rr := httptest.NewRecorder()
	s.handlePortForwardList(rr, httptest.NewRequest(http.MethodGet, "/api/portforward", nil))
	var body struct {
		Forwards []map[string]any `json:"forwards"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	return body.Forwards
}

func TestPortForwardHandlersLifecycle(t *testing.T) {
	s := newPortForwardTestServer(t)
	info := startForward(t, s, "ctx-a")
	if info.Status != "starting" || info.Address != "127.0.0.1" || info.LocalPort == 0 || info.Context != "ctx-a" {
		t.Fatalf("info = %+v", info)
	}

	l := listForwards(t, s)
	if len(l) != 1 || l[0]["id"] != info.ID || l[0]["remote_port"] != float64(8080) || l[0]["kind"] != "pod" {
		t.Fatalf("list = %+v", l)
	}

	rr := httptest.NewRecorder()
	s.handlePortForwardStop(rr, httptest.NewRequest(http.MethodPost, "/api/portforward/stop", toJSONBody(t, map[string]string{"id": info.ID})))
	if rr.Code != http.StatusOK {
		t.Fatalf("stop: %d %s", rr.Code, rr.Body.String())
	}
	if len(listForwards(t, s)) != 0 {
		t.Fatal("forward still listed after stop")
	}
	rr = httptest.NewRecorder()
	s.handlePortForwardStop(rr, httptest.NewRequest(http.MethodPost, "/api/portforward/stop", toJSONBody(t, map[string]string{"id": info.ID})))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("second stop: %d", rr.Code)
	}
}

func TestPortForwardStartValidation(t *testing.T) {
	s := newPortForwardTestServer(t)
	rr := httptest.NewRecorder()
	s.handlePortForwardStart(rr, httptest.NewRequest(http.MethodPost, "/api/portforward/start", toJSONBody(t, map[string]any{
		"context": "c", "namespace": "ns", "kind": "deployment", "name": "x", "remote_port": 80,
	})))
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("code = %d", rr.Code)
	}
	rr = httptest.NewRecorder()
	s.handlePortForwardList(rr, httptest.NewRequest(http.MethodPost, "/api/portforward", nil))
	if rr.Code != http.StatusMethodNotAllowed {
		t.Fatalf("list POST code = %d", rr.Code)
	}
}

func TestPortForwardAllowedInReadOnlyMode(t *testing.T) {
	s := newPortForwardTestServer(t)
	s.SetReadOnly(true)
	startForward(t, s, "c")
}

func TestPortForwardsStopOnLock(t *testing.T) {
	s := newPortForwardTestServer(t)
	startForward(t, s, "a")
	startForward(t, s, "b")
	rr := httptest.NewRecorder()
	s.handleSetupLock(rr, httptest.NewRequest(http.MethodPost, "/api/setup/lock", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("lock: %d %s", rr.Code, rr.Body.String())
	}
	if l := listForwards(t, s); len(l) != 0 {
		t.Fatalf("forwards survived lock: %+v", l)
	}
	// Starting while locked is refused.
	rr = httptest.NewRecorder()
	s.handlePortForwardStart(rr, httptest.NewRequest(http.MethodPost, "/api/portforward/start", toJSONBody(t, map[string]any{
		"context": "a", "namespace": "ns", "kind": "pod", "name": "web-0", "remote_port": 8080,
	})))
	if rr.Code != http.StatusConflict {
		t.Fatalf("start while locked: %d", rr.Code)
	}
}

func TestPortForwardsStopOnShutdown(t *testing.T) {
	s := newPortForwardTestServer(t)
	startForward(t, s, "a")
	if err := s.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if l := listForwards(t, s); len(l) != 0 {
		t.Fatalf("forwards survived shutdown: %+v", l)
	}
}

func TestStopContextPortForwards(t *testing.T) {
	s := newPortForwardTestServer(t)
	startForward(t, s, "keep")
	startForward(t, s, "gone")
	s.stopContextPortForwards("gone")
	l := listForwards(t, s)
	if len(l) != 1 || l[0]["context"] != "keep" {
		t.Fatalf("list = %+v", l)
	}
}
