package kube

import (
	"fmt"
	"net/http"
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
	// WatchDynamic shares Dynamic's transport but has no client-side request
	// timeout, so long-lived informer watches are not cut off.
	WatchDynamic dynamic.Interface
}

// InformerClient returns the dynamic client informers should use.
func (cs *ClientSet) InformerClient() dynamic.Interface {
	if cs.WatchDynamic != nil {
		return cs.WatchDynamic
	}
	return cs.Dynamic
}

// Manager manages Kubernetes clients per context using the encrypted store.
type Manager struct {
	mu            sync.RWMutex
	store         *contextstore.Store
	clients       map[string]*ClientSet
	activeContext string

	healthOnce sync.Once
	ht         *healthTracker
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
	m.resetAllHealth()
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
// While the context's auth circuit breaker is open it returns the cached
// classified error without building a client or invoking a credential plugin.
// A context whose exec/auth-provider/file-reference configuration is not
// approved gets an EXEC_APPROVAL_REQUIRED *AuthError and no client.
func (m *Manager) GetClientSet(contextName string) (*ClientSet, error) {
	if err := m.breakerError(contextName); err != nil {
		return nil, err
	}
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

	// Never let client-go run an exec plugin / auth-provider or follow local
	// file references the user has not approved in their current form.
	if err := m.checkExecApproval(contextName, entry); err != nil {
		return nil, err
	}

	restConfig, err := clientcmd.RESTConfigFromKubeConfig([]byte(entry.Kubeconfig))
	if err != nil {
		return nil, fmt.Errorf("building rest config for context %q: %w", contextName, err)
	}
	restConfig.QPS = float32(envFloat("KUBED_CLIENT_QPS", defaultClientQPS))
	restConfig.Burst = envInt("KUBED_CLIENT_BURST", defaultClientBurst)
	restConfig.Timeout = requestTimeout

	// Build the HTTP client ourselves so the health transport is the outermost
	// RoundTripper (outside client-go's exec credential wrapper).
	baseClient, err := rest.HTTPClientFor(restConfig)
	if err != nil {
		return nil, fmt.Errorf("creating http client for context %q: %w", contextName, err)
	}
	transport := &healthTransport{m: m, context: contextName, base: baseClient.Transport}
	httpClient := &http.Client{Transport: transport, Timeout: restConfig.Timeout, Jar: baseClient.Jar}
	watchHTTPClient := &http.Client{Transport: transport, Jar: baseClient.Jar}

	clientset, err := kubernetes.NewForConfigAndClient(restConfig, httpClient)
	if err != nil {
		return nil, fmt.Errorf("creating clientset for context %q: %w", contextName, err)
	}

	dynClient, err := dynamic.NewForConfigAndClient(restConfig, httpClient)
	if err != nil {
		return nil, fmt.Errorf("creating dynamic client for context %q: %w", contextName, err)
	}

	watchConfig := rest.CopyConfig(restConfig)
	watchConfig.Timeout = 0
	watchDyn, err := dynamic.NewForConfigAndClient(watchConfig, watchHTTPClient)
	if err != nil {
		return nil, fmt.Errorf("creating watch client for context %q: %w", contextName, err)
	}

	cs := &ClientSet{
		Clientset:    clientset,
		Dynamic:      dynClient,
		Discovery:    clientset.Discovery(),
		Config:       restConfig,
		WatchDynamic: watchDyn,
	}
	m.clients[contextName] = cs
	return cs, nil
}

// InvalidateClient removes the cached client for a context, forcing recreation on next use.
// Call this after a context's kubeconfig is updated in the store.
func (m *Manager) InvalidateClient(contextName string) {
	m.mu.Lock()
	delete(m.clients, contextName)
	m.mu.Unlock()
	m.ResetHealth(contextName)
}

// ClearAllClients removes all cached clients and resets the active context.
// Call this after a store reset.
func (m *Manager) ClearAllClients() {
	m.resetAllHealth()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.clients = make(map[string]*ClientSet)
	m.activeContext = ""
}
