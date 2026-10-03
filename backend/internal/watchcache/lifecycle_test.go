package watchcache

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	disc "github.com/kroy/truss/backend/internal/discovery"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynfake "k8s.io/client-go/dynamic/fake"
)

var cmGVR = schema.GroupVersionResource{Version: "v1", Resource: "configmaps"}

var cmResources = []disc.ResourceInfo{{Version: "v1", Resource: "configmaps", Kind: "ConfigMap", Namespaced: true}}

func newFakeClient(objs ...runtime.Object) *dynfake.FakeDynamicClient {
	return dynfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{cmGVR: "ConfigMapList"}, objs...)
}

func configMap(name string) *unstructured.Unstructured {
	cm := &unstructured.Unstructured{}
	cm.SetAPIVersion("v1")
	cm.SetKind("ConfigMap")
	cm.SetName(name)
	cm.SetNamespace("default")
	return cm
}

func ev(name string) ResourceEvent {
	return ResourceEvent{Context: "ctx", Resource: "configmaps", Namespace: "default", Name: name, Verb: "update"}
}

func waitSynced(t *testing.T, m *Manager, ctx string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, synced := m.ListAll(ctx, cmGVR, ""); synced {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("cache never synced")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestOverflowMarksResyncOnceAfterDrain(t *testing.T) {
	m := New()
	m.subBuffer = 2
	injectContext(m, "ctx")
	sub, _ := m.Subscribe("ctx")
	defer sub.Cancel()

	for i := 0; i < 5; i++ {
		m.deliver("ctx", ev(fmt.Sprintf("cm-%d", i)))
	}

	select {
	case <-sub.ResyncPending():
	default:
		t.Fatal("overflow should signal a pending resync")
	}
	if _, ok := sub.TakeResync(); ok {
		t.Fatal("resync must wait until the buffered events drain")
	}
	<-sub.Events()
	<-sub.Events()
	reason, ok := sub.TakeResync()
	if !ok || reason != ResyncReasonOverflow {
		t.Fatalf("TakeResync = %q,%v; want %q,true", reason, ok, ResyncReasonOverflow)
	}
	if _, ok := sub.TakeResync(); ok {
		t.Fatal("overflow episode must produce exactly one resync")
	}

	// A new overflow starts a new episode.
	for i := 0; i < 3; i++ {
		m.deliver("ctx", ev("again"))
	}
	<-sub.Events()
	<-sub.Events()
	if _, ok := sub.TakeResync(); !ok {
		t.Fatal("second overflow episode should resync again")
	}
}

func TestResyncAfterInvalidateAndRestart(t *testing.T) {
	client := newFakeClient(configMap("a"))
	m := New()
	defer m.StopAll()
	m.EnsureStarted("ctx", client, cmResources)
	sub, ok := m.Subscribe("ctx")
	if !ok {
		t.Fatal("Subscribe failed")
	}
	defer sub.Cancel()

	m.Invalidate("ctx")
	select {
	case <-sub.ResyncPending():
		t.Fatal("resync should be sent when informers restart, not on stop")
	default:
	}

	m.EnsureStarted("ctx", client, cmResources)
	select {
	case <-sub.ResyncPending():
	case <-time.After(2 * time.Second):
		t.Fatal("restart should signal a resync")
	}
	// Drain any events from the new informer's initial list, then take.
	deadline := time.Now().Add(2 * time.Second)
	for {
		for len(sub.Events()) > 0 {
			<-sub.Events()
		}
		if reason, ok := sub.TakeResync(); ok {
			if reason != ResyncReasonRestarted {
				t.Fatalf("reason = %q, want %q", reason, ResyncReasonRestarted)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("resync never became takeable")
		}
		time.Sleep(5 * time.Millisecond)
	}

	// Subscription still receives events from the new informers.
	waitSynced(t, m, "ctx")
	if _, err := client.Resource(cmGVR).Namespace("default").Create(context.Background(), configMap("b"), metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	timeout := time.After(5 * time.Second)
	for {
		select {
		case e := <-sub.Events():
			if e.Name == "b" {
				return
			}
		case <-timeout:
			t.Fatal("no event for b after restart")
		}
	}
}

func TestRequestResync(t *testing.T) {
	m := New()
	injectContext(m, "ctx")
	sub, _ := m.Subscribe("ctx")
	defer sub.Cancel()
	m.RequestResync("ctx", ResyncReasonRecovered)
	m.RequestResync("ctx", ResyncReasonOverflow) // coalesced
	reason, ok := sub.TakeResync()
	if !ok || reason != ResyncReasonRecovered {
		t.Fatalf("TakeResync = %q,%v", reason, ok)
	}
}

func TestReapIdle(t *testing.T) {
	m := New()
	now := time.Unix(1_000_000, 0)
	var mu sync.Mutex
	m.now = func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	advance := func(d time.Duration) { mu.Lock(); now = now.Add(d); mu.Unlock() }
	m.idleTTL = 5 * time.Minute

	for _, name := range []string{"active", "watched", "idle"} {
		injectContext(m, name).touch(m.now())
	}
	sub, _ := m.Subscribe("watched")
	defer sub.Cancel()
	isActive := func(n string) bool { return n == "active" }

	advance(4 * time.Minute)
	if got := m.reapIdle(isActive); len(got) != 0 {
		t.Fatalf("reaped before TTL: %v", got)
	}
	// Use resets the idle clock.
	m.ListAll("idle", cmGVR, "")
	advance(2 * time.Minute)
	if got := m.reapIdle(isActive); len(got) != 0 {
		t.Fatalf("reaped despite recent use: %v", got)
	}
	advance(4 * time.Minute)
	got := m.reapIdle(isActive)
	if len(got) != 1 || got[0] != "idle" {
		t.Fatalf("reaped = %v, want [idle]", got)
	}
	m.mu.RLock()
	_, activeKept := m.contexts["active"]
	_, watchedKept := m.contexts["watched"]
	m.mu.RUnlock()
	if !activeKept || !watchedKept {
		t.Fatal("active and watched contexts must never be reaped")
	}

	// Once the last subscriber leaves, the idle clock starts from then.
	sub.Cancel()
	advance(time.Minute)
	if got := m.reapIdle(isActive); len(got) != 0 {
		t.Fatalf("reaped right after unsubscribe: %v", got)
	}
	advance(5 * time.Minute)
	if got := m.reapIdle(isActive); len(got) != 1 || got[0] != "watched" {
		t.Fatalf("reaped = %v, want [watched]", got)
	}
}

func TestJanitorRunsAndStopsOnClose(t *testing.T) {
	m := New()
	m.idleTTL = 0
	m.janitorTick = 5 * time.Millisecond
	injectContext(m, "idle")
	injectContext(m, "active")
	m.StartJanitor(func(n string) bool { return n == "active" })
	m.StartJanitor(nil) // second call is a no-op

	deadline := time.Now().Add(2 * time.Second)
	for {
		m.mu.RLock()
		_, present := m.contexts["idle"]
		m.mu.RUnlock()
		if !present {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("janitor never reaped idle context")
		}
		time.Sleep(5 * time.Millisecond)
	}
	m.mu.RLock()
	_, activePresent := m.contexts["active"]
	m.mu.RUnlock()
	if !activePresent {
		t.Fatal("janitor stopped the active context")
	}
	m.Close()
	if m.janitorStop != nil {
		t.Fatal("Close should stop the janitor")
	}
	m.Close() // idempotent
}

// TestEnsureStartedInvalidateRace hammers EnsureStarted against
// Invalidate/StopAll; run with -race. Before the fix, informers could be
// started on an already-closed stopCh and events from orphaned caches leaked.
func TestEnsureStartedInvalidateRace(t *testing.T) {
	client := newFakeClient(configMap("a"))
	m := New()
	defer m.StopAll()

	var wg sync.WaitGroup
	const n = 50
	for i := 0; i < 4; i++ {
		wg.Add(3)
		go func() {
			defer wg.Done()
			for j := 0; j < n; j++ {
				m.EnsureStarted("ctx", client, cmResources)
			}
		}()
		go func() {
			defer wg.Done()
			for j := 0; j < n; j++ {
				m.Invalidate("ctx")
				if j%10 == 0 {
					m.StopAll()
				}
			}
		}()
		go func() {
			defer wg.Done()
			for j := 0; j < n; j++ {
				if sub, ok := m.Subscribe("ctx"); ok {
					m.ListAll("ctx", cmGVR, "")
					sub.Cancel()
				}
			}
		}()
	}
	wg.Wait()

	// After the storm, a final EnsureStarted yields a live, syncing cache.
	m.EnsureStarted("ctx", client, cmResources)
	m.mu.RLock()
	cc := m.contexts["ctx"]
	m.mu.RUnlock()
	if cc == nil || cc.stopped.Load() {
		t.Fatal("expected a live cache after EnsureStarted")
	}
	waitSynced(t, m, "ctx")
}
