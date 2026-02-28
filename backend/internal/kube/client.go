package kube

import (
	"fmt"
	"os"
	"strconv"
	"sync"

	"github.com/kroy/truss/backend/internal/contextstore"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

// ClientSet holds all Kubernetes clients for a given context.
type ClientSet struct {
	Clientset *kubernetes.Clientset
	Dynamic   dynamic.Interface
	Discovery discovery.DiscoveryInterface
	Config    *rest.Config
}

// Manager manages Kubernetes clients per context using the encrypted store.
type Manager struct {
	mu            sync.RWMutex
	store         *contextstore.Store
	clients       map[string]*ClientSet
	activeContext string
}

const (
	defaultClientQPS   = 40.0
	defaultClientBurst = 80
)

func envFloat(name string, fallback float64) float64 {
	v := os.Getenv(name)
	if v == "" {
		return fallback
	}
	parsed, err := strconv.ParseFloat(v, 32)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func envInt(name string, fallback int) int {
	v := os.Getenv(name)
	if v == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(v)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

// NewManager creates a Manager backed by the encrypted context store.
func NewManager(store *contextstore.Store) *Manager {
	m := &Manager{
		store:   store,
		clients: make(map[string]*ClientSet),
	}
	m.RefreshFromStore()
	return m
}

// ContextNames returns all stored context names (sorted).
func (m *Manager) ContextNames() []string {
	return m.store.ContextNames()
}

// GetContext returns the parsed kubeconfig context for the given store key.
// The returned *clientcmdapi.Context has Cluster and AuthInfo fields.
func (m *Manager) GetContext(name string) (*clientcmdapi.Context, bool) {
	entry, ok := m.store.GetContextEntry(name)
	if !ok {
		return nil, false
	}
	cfg, err := clientcmd.Load([]byte(entry.Kubeconfig))
	if err != nil {
		return nil, false
	}
	ctx, ok := cfg.Contexts[cfg.CurrentContext]
	return ctx, ok
}

// ActiveContext returns the current active context name.
func (m *Manager) ActiveContext() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.activeContext
}

// SetActiveContext changes and persists the active context.
func (m *Manager) SetActiveContext(name string) error {
	_, ok := m.store.GetContextEntry(name)
	if !ok {
		return fmt.Errorf("context %q not found", name)
	}
	if err := m.store.SetActiveContext(name); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.activeContext = name
	return nil
}

// RefreshFromStore refreshes active context and clears cached clients.
// Call this after profile operations.
func (m *Manager) RefreshFromStore() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.clients = make(map[string]*ClientSet)
	m.activeContext = ""
	if saved := m.store.LastActiveContext(); saved != "" {
		if _, ok := m.store.GetContextEntry(saved); ok {
			m.activeContext = saved
		}
	}
	if m.activeContext == "" {
		if names := m.store.ContextNames(); len(names) > 0 {
			m.activeContext = names[0]
		}
	}
}

// GetClientSet returns or creates a ClientSet for the given context name.
func (m *Manager) GetClientSet(contextName string) (*ClientSet, error) {
	m.mu.RLock()
	if cs, ok := m.clients[contextName]; ok {
		m.mu.RUnlock()
		return cs, nil
	}
	m.mu.RUnlock()

	m.mu.Lock()
	defer m.mu.Unlock()

	// Double-check after acquiring write lock.
	if cs, ok := m.clients[contextName]; ok {
		return cs, nil
	}

	entry, ok := m.store.GetContextEntry(contextName)
	if !ok {
		return nil, fmt.Errorf("context %q not found in store", contextName)
	}

	restConfig, err := clientcmd.RESTConfigFromKubeConfig([]byte(entry.Kubeconfig))
	if err != nil {
		return nil, fmt.Errorf("building rest config for context %q: %w", contextName, err)
	}
	restConfig.QPS = float32(envFloat("KUBED_CLIENT_QPS", defaultClientQPS))
	restConfig.Burst = envInt("KUBED_CLIENT_BURST", defaultClientBurst)

	clientset, err := kubernetes.NewForConfig(restConfig)
	if err != nil {
		return nil, fmt.Errorf("creating clientset for context %q: %w", contextName, err)
	}

	dynClient, err := dynamic.NewForConfig(restConfig)
	if err != nil {
		return nil, fmt.Errorf("creating dynamic client for context %q: %w", contextName, err)
	}

	cs := &ClientSet{
		Clientset: clientset,
		Dynamic:   dynClient,
		Discovery: clientset.Discovery(),
		Config:    restConfig,
	}
	m.clients[contextName] = cs
	return cs, nil
}

// InvalidateClient removes the cached client for a context, forcing recreation on next use.
// Call this after a context's kubeconfig is updated in the store.
func (m *Manager) InvalidateClient(contextName string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.clients, contextName)
}

// ClearAllClients removes all cached clients and resets the active context.
// Call this after a store reset.
func (m *Manager) ClearAllClients() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.clients = make(map[string]*ClientSet)
	m.activeContext = ""
}
