package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
	disc "github.com/kroy/truss/backend/internal/discovery"
	"github.com/kroy/truss/backend/internal/watchcache"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynfake "k8s.io/client-go/dynamic/fake"
)

// newWatchStreamServer starts informers for "ctx" on a fake client and serves
// serveWatchStream (the /ws/watch body after auth/subscription) over httptest.
func newWatchStreamServer(t *testing.T) (*Server, string, chan struct{}) {
	t.Helper()
	s := newSetupServer(t)
	gvr := schema.GroupVersionResource{Version: "v1", Resource: "configmaps"}
	client := dynfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{gvr: "ConfigMapList"})
	s.watchCache.EnsureStarted("ctx", client, []disc.ResourceInfo{{Version: "v1", Resource: "configmaps", Kind: "ConfigMap", Namespaced: true}})
	t.Cleanup(s.watchCache.Close)

	done := make(chan struct{}, 4)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() { done <- struct{}{} }()
		sub, ok := s.watchCache.Subscribe("ctx")
		if !ok {
			http.Error(w, "no cache", http.StatusServiceUnavailable)
			return
		}
		defer sub.Cancel()
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")
		s.serveWatchStream(r.Context(), conn, "ctx", "", sub)
	}))
	t.Cleanup(ts.Close)
	return s, "ws" + strings.TrimPrefix(ts.URL, "http"), done
}

func dialWatch(t *testing.T, url string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	return conn
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// readUntilType reads messages until one of the given type arrives.
func readUntilType(t *testing.T, conn *websocket.Conn, typ string) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read waiting for %q: %v", typ, err)
		}
		var msg map[string]any
		if err := json.Unmarshal(data, &msg); err != nil {
			t.Fatalf("bad json %s: %v", data, err)
		}
		if msg["type"] == typ {
			return msg
		}
	}
}

func TestWatchStreamClientDisconnectCleansUpPromptly(t *testing.T) {
	old := watchPingInterval
	watchPingInterval = time.Hour // prove cleanup does not depend on a write failing
	t.Cleanup(func() { watchPingInterval = old })

	s, url, done := newWatchStreamServer(t)
	conn := dialWatch(t, url)
	waitFor(t, "subscription", func() bool { return s.watchCache.SubscriberCount("ctx") == 1 })

	_ = conn.CloseNow()

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("handler did not exit after client disconnect")
	}
	if n := s.watchCache.SubscriberCount("ctx"); n != 0 {
		t.Fatalf("subscription leaked: %d remaining", n)
	}
}

func TestWatchStreamSendsResync(t *testing.T) {
	s, url, _ := newWatchStreamServer(t)
	conn := dialWatch(t, url)
	defer conn.CloseNow()
	waitFor(t, "subscription", func() bool { return s.watchCache.SubscriberCount("ctx") == 1 })

	s.watchCache.RequestResync("ctx", watchcache.ResyncReasonOverflow)
	msg := readUntilType(t, conn, "resync")
	if msg["reason"] != "subscriber buffer overflow" {
		t.Fatalf("reason = %v", msg["reason"])
	}
}

func TestWatchStreamResyncOnHealthRecovery(t *testing.T) {
	s, url, _ := newWatchStreamServer(t)
	s.kubeMgr.RecordError("ctx", fmt.Errorf("dial tcp: %w", syscall.ECONNREFUSED))
	if !s.kubeMgr.InErrorState("ctx") {
		t.Fatal("setup: context should be in error state")
	}
	conn := dialWatch(t, url)
	defer conn.CloseNow()
	waitFor(t, "subscription", func() bool { return s.watchCache.SubscriberCount("ctx") == 1 })

	s.kubeMgr.RecordSuccess("ctx")
	h := readUntilType(t, conn, "health")
	if hh, _ := h["health"].(map[string]any); hh["state"] != "ok" {
		t.Fatalf("health = %v", h)
	}
	msg := readUntilType(t, conn, "resync")
	if msg["reason"] != watchcache.ResyncReasonRecovered {
		t.Fatalf("reason = %v", msg["reason"])
	}
}

func TestWatchStreamSurvivesInvalidateAndResyncsOnRestart(t *testing.T) {
	s, url, _ := newWatchStreamServer(t)
	conn := dialWatch(t, url)
	defer conn.CloseNow()
	waitFor(t, "subscription", func() bool { return s.watchCache.SubscriberCount("ctx") == 1 })

	s.watchCache.Invalidate("ctx")
	gvr := schema.GroupVersionResource{Version: "v1", Resource: "configmaps"}
	client := dynfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{gvr: "ConfigMapList"})
	s.watchCache.EnsureStarted("ctx", client, []disc.ResourceInfo{{Version: "v1", Resource: "configmaps", Kind: "ConfigMap", Namespaced: true}})

	msg := readUntilType(t, conn, "resync")
	if msg["reason"] != watchcache.ResyncReasonRestarted {
		t.Fatalf("reason = %v", msg["reason"])
	}
}
