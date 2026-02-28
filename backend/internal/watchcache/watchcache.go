package watchcache

import (
	"sync"
	"time"

	disc "github.com/kroy/truss/backend/internal/discovery"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/informers"
	kcache "k8s.io/client-go/tools/cache"
)

type gvrEntry struct {
	informer informers.GenericInformer
}

type contextCache struct {
	factory   dynamicinformer.DynamicSharedInformerFactory
	stopCh    chan struct{}
	mu        sync.RWMutex
	gvrs      map[schema.GroupVersionResource]*gvrEntry
	nextSubID int
	subs      map[int]chan ResourceEvent
}

// ResourceEvent is a lightweight cache change notification emitted from informer handlers.
type ResourceEvent struct {
	Context   string                      `json:"context"`
	Group     string                      `json:"group"`
	Version   string                      `json:"version"`
	Resource  string                      `json:"resource"`
	Namespace string                      `json:"namespace"`
	Name      string                      `json:"name"`
	Verb      string                      `json:"verb"`
	AtUnixMs  int64                       `json:"at_unix_ms"`
	GVR       schema.GroupVersionResource `json:"-"`
}

// Manager manages per-context watch caches backed by dynamic informers.
type Manager struct {
	mu       sync.RWMutex
	contexts map[string]*contextCache
}

// New creates a new Manager.
func New() *Manager {
	return &Manager{
		contexts: make(map[string]*contextCache),
	}
}

// EnsureStarted is idempotent and safe for concurrent calls.
// It creates a factory if absent, registers any new GVRs, and calls factory.Start().
func (m *Manager) EnsureStarted(contextName string, dynClient dynamic.Interface, resources []disc.ResourceInfo) {
	m.mu.Lock()
	cc, ok := m.contexts[contextName]
	if !ok {
		cc = &contextCache{
			factory: dynamicinformer.NewDynamicSharedInformerFactory(dynClient, 0),
			stopCh:  make(chan struct{}),
			gvrs:    make(map[schema.GroupVersionResource]*gvrEntry),
			subs:    make(map[int]chan ResourceEvent),
		}
		m.contexts[contextName] = cc
	}
	m.mu.Unlock()

	cc.mu.Lock()
	for _, r := range resources {
		gvr := schema.GroupVersionResource{Group: r.Group, Version: r.Version, Resource: r.Resource}
		if _, exists := cc.gvrs[gvr]; !exists {
			inf := cc.factory.ForResource(gvr)
			inf.Informer().AddEventHandler(kcache.ResourceEventHandlerFuncs{
				AddFunc: func(obj interface{}) {
					m.broadcast(contextName, gvr, "add", obj)
				},
				UpdateFunc: func(_, newObj interface{}) {
					m.broadcast(contextName, gvr, "update", newObj)
				},
				DeleteFunc: func(obj interface{}) {
					m.broadcast(contextName, gvr, "delete", obj)
				},
			})
			cc.gvrs[gvr] = &gvrEntry{informer: inf}
		}
	}
	cc.mu.Unlock()

	// factory.Start is safe to call multiple times; it only launches goroutines
	// for informers not yet started.
	cc.factory.Start(cc.stopCh)
}

func (m *Manager) broadcast(contextName string, gvr schema.GroupVersionResource, verb string, obj interface{}) {
	u, ok := toUnstructured(obj)
	if !ok || u == nil {
		return
	}
	ev := ResourceEvent{
		Context:   contextName,
		Group:     gvr.Group,
		Version:   gvr.Version,
		Resource:  gvr.Resource,
		Namespace: u.GetNamespace(),
		Name:      u.GetName(),
		Verb:      verb,
		AtUnixMs:  time.Now().UnixMilli(),
		GVR:       gvr,
	}

	m.mu.RLock()
	cc, ok := m.contexts[contextName]
	m.mu.RUnlock()
	if !ok {
		return
	}
	cc.mu.RLock()
	defer cc.mu.RUnlock()
	for _, ch := range cc.subs {
		select {
		case ch <- ev:
		default:
			// Drop if subscriber is slow; stream is best-effort invalidation.
		}
	}
}

func toUnstructured(obj interface{}) (*unstructured.Unstructured, bool) {
	switch t := obj.(type) {
	case *unstructured.Unstructured:
		return t, true
	case unstructured.Unstructured:
		return &t, true
	case kcache.DeletedFinalStateUnknown:
		return toUnstructured(t.Obj)
	case *kcache.DeletedFinalStateUnknown:
		if t == nil {
			return nil, false
		}
		return toUnstructured(t.Obj)
	default:
		return nil, false
	}
}

// Subscribe returns a best-effort stream of informer change notifications for a context.
func (m *Manager) Subscribe(contextName string) (<-chan ResourceEvent, func(), bool) {
	m.mu.RLock()
	cc, ok := m.contexts[contextName]
	m.mu.RUnlock()
	if !ok {
		return nil, nil, false
	}

	cc.mu.Lock()
	defer cc.mu.Unlock()
	id := cc.nextSubID
	cc.nextSubID++
	ch := make(chan ResourceEvent, 256)
	cc.subs[id] = ch
	cancel := func() {
		cc.mu.Lock()
		defer cc.mu.Unlock()
		if existing, ok := cc.subs[id]; ok {
			delete(cc.subs, id)
			close(existing)
		}
	}
	return ch, cancel, true
}

// ListAll returns all items for the given GVR and namespace from the cache.
// synced=false means the informer is not yet warm; the caller should fall back to the API.
func (m *Manager) ListAll(contextName string, gvr schema.GroupVersionResource, namespace string) ([]unstructured.Unstructured, bool) {
	m.mu.RLock()
	cc, ok := m.contexts[contextName]
	m.mu.RUnlock()
	if !ok {
		return nil, false
	}

	cc.mu.RLock()
	entry, ok := cc.gvrs[gvr]
	cc.mu.RUnlock()
	if !ok {
		return nil, false
	}

	if !entry.informer.Informer().HasSynced() {
		return nil, false
	}

	var objs []runtime.Object
	var err error
	if namespace == "" {
		objs, err = entry.informer.Lister().List(labels.Everything())
	} else {
		objs, err = entry.informer.Lister().ByNamespace(namespace).List(labels.Everything())
	}
	if err != nil {
		return nil, false
	}

	items := make([]unstructured.Unstructured, 0, len(objs))
	for _, obj := range objs {
		u, ok := obj.(*unstructured.Unstructured)
		if !ok {
			continue
		}
		// Deep-copy to prevent callers from mutating the cache store.
		items = append(items, *u.DeepCopy())
	}
	return items, true
}

// HasGVR returns true if an informer is registered for the given GVR in the named context.
func (m *Manager) HasGVR(contextName string, gvr schema.GroupVersionResource) bool {
	m.mu.RLock()
	cc, ok := m.contexts[contextName]
	m.mu.RUnlock()
	if !ok {
		return false
	}
	cc.mu.RLock()
	_, ok = cc.gvrs[gvr]
	cc.mu.RUnlock()
	return ok
}

// Len is a convenience wrapper around ListAll that returns only the count.
func (m *Manager) Len(contextName string, gvr schema.GroupVersionResource, namespace string) (int, bool) {
	items, synced := m.ListAll(contextName, gvr, namespace)
	if !synced {
		return 0, false
	}
	return len(items), true
}

// Invalidate stops informers for a single context and removes it from the map.
// Used on context delete/re-import.
func (m *Manager) Invalidate(contextName string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	cc, ok := m.contexts[contextName]
	if ok {
		cc.mu.Lock()
		for id, ch := range cc.subs {
			close(ch)
			delete(cc.subs, id)
		}
		cc.mu.Unlock()
		close(cc.stopCh)
		delete(m.contexts, contextName)
	}
}

// StopAll invalidates every context. Used on store lock / reset.
func (m *Manager) StopAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for name, cc := range m.contexts {
		cc.mu.Lock()
		for id, ch := range cc.subs {
			close(ch)
			delete(cc.subs, id)
		}
		cc.mu.Unlock()
		close(cc.stopCh)
		delete(m.contexts, name)
	}
}
