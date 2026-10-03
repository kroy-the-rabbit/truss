package watchcache

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	kcache "k8s.io/client-go/tools/cache"
)

// ---------------------------------------------------------------------------
// toUnstructured
// ---------------------------------------------------------------------------

func TestToUnstructuredPointer(t *testing.T) {
	obj := &unstructured.Unstructured{}
	obj.SetName("test-pod")
	got, ok := toUnstructured(obj)
	if !ok || got == nil {
		t.Fatal("expected ok=true and non-nil result for *Unstructured")
	}
	if got.GetName() != "test-pod" {
		t.Errorf("got name %q, want test-pod", got.GetName())
	}
}

func TestToUnstructuredValue(t *testing.T) {
	obj := unstructured.Unstructured{}
	obj.SetName("test-node")
	got, ok := toUnstructured(obj)
	if !ok || got == nil {
		t.Fatal("expected ok=true for Unstructured value")
	}
	if got.GetName() != "test-node" {
		t.Errorf("got name %q, want test-node", got.GetName())
	}
}

func TestToUnstructuredDeletedFinalStateUnknown(t *testing.T) {
	inner := &unstructured.Unstructured{}
	inner.SetName("evicted-pod")
	tombstone := kcache.DeletedFinalStateUnknown{Key: "default/evicted-pod", Obj: inner}
	got, ok := toUnstructured(tombstone)
	if !ok || got == nil {
		t.Fatal("expected ok=true for DeletedFinalStateUnknown wrapping *Unstructured")
	}
	if got.GetName() != "evicted-pod" {
		t.Errorf("got name %q, want evicted-pod", got.GetName())
	}
}

func TestToUnstructuredDeletedFinalStateUnknownPointer(t *testing.T) {
	inner := &unstructured.Unstructured{}
	inner.SetName("ptr-pod")
	tombstone := &kcache.DeletedFinalStateUnknown{Key: "default/ptr-pod", Obj: inner}
	got, ok := toUnstructured(tombstone)
	if !ok || got == nil {
		t.Fatal("expected ok=true for *DeletedFinalStateUnknown")
	}
	if got.GetName() != "ptr-pod" {
		t.Errorf("got name %q, want ptr-pod", got.GetName())
	}
}

func TestToUnstructuredNilPointerDeletedState(t *testing.T) {
	var tombstone *kcache.DeletedFinalStateUnknown // nil pointer
	got, ok := toUnstructured(tombstone)
	if ok || got != nil {
		t.Error("expected ok=false and nil result for nil *DeletedFinalStateUnknown")
	}
}

func TestToUnstructuredUnknownType(t *testing.T) {
	got, ok := toUnstructured("not-an-unstructured")
	if ok || got != nil {
		t.Error("expected ok=false and nil for unknown type")
	}
}

func TestToUnstructuredNilInput(t *testing.T) {
	got, ok := toUnstructured(nil)
	if ok || got != nil {
		t.Error("expected ok=false for nil input")
	}
}

// ---------------------------------------------------------------------------
// Manager: New, HasGVR, Subscribe, Invalidate, StopAll
// ---------------------------------------------------------------------------

// injectContext adds a contextCache directly for testing without EnsureStarted.
func injectContext(m *Manager, name string) *contextCache {
	cc := &contextCache{
		stopCh: make(chan struct{}),
		gvrs:   make(map[schema.GroupVersionResource]*gvrEntry),
	}
	m.mu.Lock()
	m.contexts[name] = cc
	m.mu.Unlock()
	return cc
}

func TestNew(t *testing.T) {
	m := New()
	if m == nil {
		t.Fatal("New() returned nil")
	}
	if m.contexts == nil {
		t.Error("New() should initialise contexts map")
	}
}

func TestHasGVRReturnsFalseForUnknownContext(t *testing.T) {
	m := New()
	gvr := schema.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"}
	if m.HasGVR("no-such-ctx", gvr) {
		t.Error("HasGVR should return false for unknown context")
	}
}

func TestHasGVRReturnsFalseForUnknownGVR(t *testing.T) {
	m := New()
	injectContext(m, "ctx")
	gvr := schema.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"}
	if m.HasGVR("ctx", gvr) {
		t.Error("HasGVR should return false when no GVR registered")
	}
}

func TestHasGVRReturnsTrueWhenRegistered(t *testing.T) {
	m := New()
	cc := injectContext(m, "ctx")
	gvr := schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}
	cc.mu.Lock()
	cc.gvrs[gvr] = &gvrEntry{}
	cc.mu.Unlock()

	if !m.HasGVR("ctx", gvr) {
		t.Error("HasGVR should return true for registered GVR")
	}
}

func TestSubscribeReturnsFalseForUnknownContext(t *testing.T) {
	m := New()
	sub, ok := m.Subscribe("no-such-ctx")
	if ok || sub != nil {
		t.Error("Subscribe should return ok=false for unknown context")
	}
}

func TestSubscribeAndCancel(t *testing.T) {
	m := New()
	injectContext(m, "ctx")

	sub, ok := m.Subscribe("ctx")
	if !ok || sub == nil {
		t.Fatal("Subscribe should succeed for known context")
	}
	ch := sub.Events()

	select {
	case <-ch:
		t.Error("channel should be empty initially")
	default:
	}
	if got := m.SubscriberCount("ctx"); got != 1 {
		t.Fatalf("SubscriberCount = %d, want 1", got)
	}

	sub.Cancel()
	if _, open := <-ch; open {
		t.Error("channel should be closed after Cancel()")
	}
	if got := m.SubscriberCount("ctx"); got != 0 {
		t.Fatalf("SubscriberCount after cancel = %d, want 0", got)
	}

	// Double-cancel should not panic.
	sub.Cancel()
}

func TestSubscribeMultipleSubscribers(t *testing.T) {
	m := New()
	injectContext(m, "ctx")

	s1, _ := m.Subscribe("ctx")
	s2, _ := m.Subscribe("ctx")
	defer s1.Cancel()
	defer s2.Cancel()

	if s1.Events() == s2.Events() {
		t.Error("each subscriber should get a distinct channel")
	}
}

func TestInvalidateRemovesContext(t *testing.T) {
	m := New()
	injectContext(m, "to-remove")
	injectContext(m, "keep")

	m.Invalidate("to-remove")

	m.mu.RLock()
	_, removed := m.contexts["to-remove"]
	_, kept := m.contexts["keep"]
	m.mu.RUnlock()

	if removed {
		t.Error("Invalidate should remove the context")
	}
	if !kept {
		t.Error("Invalidate should not remove other contexts")
	}
}

func TestInvalidateKeepsSubscribers(t *testing.T) {
	m := New()
	injectContext(m, "ctx")
	sub, ok := m.Subscribe("ctx")
	if !ok {
		t.Fatal("Subscribe failed")
	}
	defer sub.Cancel()

	m.Invalidate("ctx")

	select {
	case _, open := <-sub.Events():
		if !open {
			t.Fatal("Invalidate must not close subscriber channels")
		}
	default:
	}
	if got := m.SubscriberCount("ctx"); got != 1 {
		t.Fatalf("SubscriberCount = %d, want 1", got)
	}
}

func TestRemoveClosesSubscriberChannels(t *testing.T) {
	m := New()
	injectContext(m, "ctx")
	sub, ok := m.Subscribe("ctx")
	if !ok {
		t.Fatal("Subscribe failed")
	}

	m.Remove("ctx")

	if _, open := <-sub.Events(); open {
		t.Error("subscriber channels should be closed on Remove")
	}
	sub.Cancel() // must not panic after Remove
}

func TestInvalidateNonexistentContextNoOp(t *testing.T) {
	m := New()
	// Must not panic.
	m.Invalidate("never-existed")
	m.Remove("never-existed")
}

func TestStopAllRemovesAllContexts(t *testing.T) {
	m := New()
	injectContext(m, "ctx1")
	injectContext(m, "ctx2")
	injectContext(m, "ctx3")

	s1, _ := m.Subscribe("ctx1")
	s2, _ := m.Subscribe("ctx2")

	m.StopAll()

	m.mu.RLock()
	remaining := len(m.contexts)
	m.mu.RUnlock()

	if remaining != 0 {
		t.Errorf("StopAll should remove all contexts, %d remain", remaining)
	}

	// Subscriber channels must be closed.
	if _, open := <-s1.Events(); open {
		t.Error("ctx1 subscriber channel should be closed after StopAll")
	}
	if _, open := <-s2.Events(); open {
		t.Error("ctx2 subscriber channel should be closed after StopAll")
	}
}

func TestStopAllOnEmptyManagerNoOp(t *testing.T) {
	m := New()
	// Must not panic.
	m.StopAll()
}
