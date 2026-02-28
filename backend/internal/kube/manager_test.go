package kube

import (
	"testing"

	"github.com/kroy/truss/backend/internal/contextstore"
)

// fakeKubeconfig is a minimal valid kubeconfig for testing.
// The server URL is intentionally unreachable; we only test client creation, not connection.
const fakeKubeconfig = `
apiVersion: v1
kind: Config
current-context: fake-ctx
clusters:
- name: fake-cluster
  cluster:
    server: https://localhost:16443
    insecure-skip-tls-verify: true
contexts:
- name: fake-ctx
  context:
    cluster: fake-cluster
    user: fake-user
users:
- name: fake-user
  user:
    token: fake-token-for-testing
`

// newEmptyStore creates an uninitialized contextstore in a temp directory.
func newEmptyStore(t *testing.T) *contextstore.Store {
	t.Helper()
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("XDG_CONFIG_HOME", tmp)
	s, err := contextstore.New()
	if err != nil {
		t.Fatalf("contextstore.New: %v", err)
	}
	return s
}

// newInitializedStore creates an initialized contextstore with a fake context.
func newInitializedStore(t *testing.T) *contextstore.Store {
	t.Helper()
	s := newEmptyStore(t)
	if err := s.Initialize("password", "", "correct-horse-battery-staple"); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	if err := s.ImportContext("fake-ctx", "Fake", fakeKubeconfig); err != nil {
		t.Fatalf("ImportContext: %v", err)
	}
	if err := s.SetActiveContext("fake-ctx"); err != nil {
		t.Fatalf("SetActiveContext: %v", err)
	}
	return s
}

// ---------------------------------------------------------------------------
// NewManager
// ---------------------------------------------------------------------------

func TestNewManagerEmptyStoreHasNoActiveContext(t *testing.T) {
	store := newEmptyStore(t)
	m := NewManager(store)
	if m == nil {
		t.Fatal("NewManager returned nil")
	}
	if got := m.ActiveContext(); got != "" {
		t.Errorf("ActiveContext = %q, want empty for new manager with empty store", got)
	}
}

func TestNewManagerPicksUpActiveContextFromStore(t *testing.T) {
	store := newInitializedStore(t)
	m := NewManager(store)
	if got := m.ActiveContext(); got != "fake-ctx" {
		t.Errorf("ActiveContext = %q, want fake-ctx", got)
	}
}

// ---------------------------------------------------------------------------
// ContextNames
// ---------------------------------------------------------------------------

func TestContextNamesEmptyStore(t *testing.T) {
	m := NewManager(newEmptyStore(t))
	names := m.ContextNames()
	if len(names) != 0 {
		t.Errorf("ContextNames = %v, want empty", names)
	}
}

func TestContextNamesWithContext(t *testing.T) {
	m := NewManager(newInitializedStore(t))
	names := m.ContextNames()
	if len(names) != 1 || names[0] != "fake-ctx" {
		t.Errorf("ContextNames = %v, want [fake-ctx]", names)
	}
}

// ---------------------------------------------------------------------------
// GetContext
// ---------------------------------------------------------------------------

func TestGetContextNotFound(t *testing.T) {
	m := NewManager(newEmptyStore(t))
	_, ok := m.GetContext("no-such-ctx")
	if ok {
		t.Error("GetContext should return ok=false for unknown context")
	}
}

func TestGetContextFound(t *testing.T) {
	m := NewManager(newInitializedStore(t))
	ctx, ok := m.GetContext("fake-ctx")
	if !ok {
		t.Fatal("GetContext should return ok=true for known context")
	}
	if ctx == nil {
		t.Error("GetContext should return non-nil context")
	}
}

// ---------------------------------------------------------------------------
// SetActiveContext
// ---------------------------------------------------------------------------

func TestSetActiveContextNotFound(t *testing.T) {
	m := NewManager(newEmptyStore(t))
	if err := m.SetActiveContext("no-such"); err == nil {
		t.Error("SetActiveContext should return error for unknown context")
	}
}

func TestSetActiveContextSuccess(t *testing.T) {
	store := newInitializedStore(t)
	m := NewManager(store)
	// Create a second context.
	if err := store.ImportContext("ctx-2", "Second", fakeKubeconfig); err != nil {
		t.Fatalf("ImportContext: %v", err)
	}
	if err := m.SetActiveContext("ctx-2"); err != nil {
		t.Fatalf("SetActiveContext: %v", err)
	}
	if got := m.ActiveContext(); got != "ctx-2" {
		t.Errorf("ActiveContext = %q after SetActiveContext, want ctx-2", got)
	}
}

// ---------------------------------------------------------------------------
// InvalidateClient
// ---------------------------------------------------------------------------

func TestInvalidateClientNoOpOnEmptyCache(t *testing.T) {
	m := NewManager(newEmptyStore(t))
	// Must not panic.
	m.InvalidateClient("no-such")
}

func TestInvalidateClientRemovesCachedEntry(t *testing.T) {
	m := NewManager(newEmptyStore(t))
	// Manually insert a fake entry into the cache.
	m.mu.Lock()
	m.clients["fake-ctx"] = &ClientSet{}
	m.mu.Unlock()

	m.InvalidateClient("fake-ctx")

	m.mu.RLock()
	_, ok := m.clients["fake-ctx"]
	m.mu.RUnlock()
	if ok {
		t.Error("InvalidateClient should remove the cached entry")
	}
}

// ---------------------------------------------------------------------------
// ClearAllClients
// ---------------------------------------------------------------------------

func TestClearAllClientsResetsActiveContext(t *testing.T) {
	m := NewManager(newInitializedStore(t))
	if m.ActiveContext() == "" {
		t.Fatal("precondition: manager should have an active context")
	}
	m.ClearAllClients()
	if got := m.ActiveContext(); got != "" {
		t.Errorf("ActiveContext = %q after ClearAllClients, want empty", got)
	}
}

func TestClearAllClientsClearsCache(t *testing.T) {
	m := NewManager(newEmptyStore(t))
	m.mu.Lock()
	m.clients["ctx-a"] = &ClientSet{}
	m.clients["ctx-b"] = &ClientSet{}
	m.mu.Unlock()

	m.ClearAllClients()

	m.mu.RLock()
	remaining := len(m.clients)
	m.mu.RUnlock()
	if remaining != 0 {
		t.Errorf("expected 0 clients after ClearAllClients, got %d", remaining)
	}
}

// ---------------------------------------------------------------------------
// RefreshFromStore
// ---------------------------------------------------------------------------

func TestRefreshFromStoreWithActiveContext(t *testing.T) {
	store := newInitializedStore(t)
	m := NewManager(store)

	// Manually dirty the cache.
	m.mu.Lock()
	m.clients["stale"] = &ClientSet{}
	m.activeContext = "stale"
	m.mu.Unlock()

	m.RefreshFromStore()

	m.mu.RLock()
	clientCount := len(m.clients)
	active := m.activeContext
	m.mu.RUnlock()

	if clientCount != 0 {
		t.Errorf("expected 0 clients after RefreshFromStore, got %d", clientCount)
	}
	if active != "fake-ctx" {
		t.Errorf("activeContext = %q after refresh, want fake-ctx", active)
	}
}

func TestRefreshFromStoreEmptyStore(t *testing.T) {
	m := NewManager(newEmptyStore(t))
	m.mu.Lock()
	m.activeContext = "stale"
	m.mu.Unlock()

	m.RefreshFromStore()

	if got := m.ActiveContext(); got != "" {
		t.Errorf("activeContext = %q after refresh with empty store, want empty", got)
	}
}

// ---------------------------------------------------------------------------
// GetClientSet
// ---------------------------------------------------------------------------

func TestGetClientSetNotFound(t *testing.T) {
	m := NewManager(newEmptyStore(t))
	_, err := m.GetClientSet("no-such-ctx")
	if err == nil {
		t.Fatal("GetClientSet should return error for unknown context")
	}
}

func TestGetClientSetSuccessAndCaching(t *testing.T) {
	m := NewManager(newInitializedStore(t))
	cs1, err := m.GetClientSet("fake-ctx")
	if err != nil {
		t.Fatalf("GetClientSet: %v", err)
	}
	if cs1 == nil {
		t.Fatal("GetClientSet returned nil ClientSet")
	}
	if cs1.Clientset == nil || cs1.Dynamic == nil || cs1.Discovery == nil || cs1.Config == nil {
		t.Error("ClientSet fields should all be non-nil")
	}

	// Second call should return the same (cached) instance.
	cs2, err := m.GetClientSet("fake-ctx")
	if err != nil {
		t.Fatalf("GetClientSet (cached): %v", err)
	}
	if cs1 != cs2 {
		t.Error("GetClientSet should return the same cached ClientSet on second call")
	}
}

func TestGetClientSetAfterInvalidate(t *testing.T) {
	m := NewManager(newInitializedStore(t))
	cs1, err := m.GetClientSet("fake-ctx")
	if err != nil {
		t.Fatalf("GetClientSet: %v", err)
	}
	m.InvalidateClient("fake-ctx")
	cs2, err := m.GetClientSet("fake-ctx")
	if err != nil {
		t.Fatalf("GetClientSet after invalidate: %v", err)
	}
	if cs1 == cs2 {
		t.Error("GetClientSet after invalidate should return a new ClientSet, not the cached one")
	}
}
