package watchcache

import (
	"context"
	"sync"
	"sync/atomic"
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
	factory dynamicinformer.DynamicSharedInformerFactory
	stopCh  chan struct{}
	// stopped is set (under mu) before stopCh is closed. EnsureStarted checks it
	// under mu so it never registers or starts informers on a closed stopCh.
	stopped  atomic.Bool
	lastUsed atomic.Int64 // unix nanos of the last EnsureStarted/ListAll/unsubscribe
	mu       sync.RWMutex
	gvrs     map[schema.GroupVersionResource]*gvrEntry
}

func (cc *contextCache) touch(now time.Time) { cc.lastUsed.Store(now.UnixNano()) }

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

// Resync reasons sent to subscribers.
const (
	ResyncReasonOverflow  = "subscriber buffer overflow"
	ResyncReasonRestarted = "informers restarted"
	ResyncReasonRecovered = "watch recovered from error"
)

const (
	defaultSubscriberBuffer = 256
	defaultIdleTTL          = 5 * time.Minute
	defaultJanitorTick      = 30 * time.Second
)

// Subscription is a best-effort stream of change notifications for one
// context. When events had to be dropped (slow consumer) or the stream may
// have missed changes (informers restarted, watch recovered from an error),
// the subscription flags a resync: consumers should drain Events, then call
// TakeResync and, if it reports true, tell their client to refetch.
type Subscription struct {
	events chan ResourceEvent
	notify chan struct{} // cap 1; signalled when a resync becomes pending

	needsResync atomic.Bool
	reasonMu    sync.Mutex
	reason      string

	closeOnce sync.Once
	cancel    func()
}

// Events returns the event channel. It is closed when the subscription ends.
func (s *Subscription) Events() <-chan ResourceEvent { return s.events }

// ResyncPending is signalled when a resync becomes pending. Consumers should
// call TakeResync once Events is drained.
func (s *Subscription) ResyncPending() <-chan struct{} { return s.notify }

// Cancel ends the subscription. Safe to call more than once.
func (s *Subscription) Cancel() {
	if s.cancel != nil {
		s.cancel()
	}
}

// MarkResync flags that the consumer must refetch. Resyncs are coalesced: the
// first reason of an episode is kept until TakeResync clears it.
func (s *Subscription) MarkResync(reason string) {
	s.reasonMu.Lock()
	if s.needsResync.Load() {
		s.reasonMu.Unlock()
		return
	}
	s.reason = reason
	s.needsResync.Store(true)
	s.reasonMu.Unlock()
	select {
	case s.notify <- struct{}{}:
	default:
	}
}

// TakeResync returns and clears the pending resync. It reports false while
// buffered events remain, so the resync is sent after the backlog drains.
func (s *Subscription) TakeResync() (string, bool) {
	if len(s.events) > 0 || !s.needsResync.Load() {
		return "", false
	}
	s.reasonMu.Lock()
	defer s.reasonMu.Unlock()
	if !s.needsResync.Load() {
		return "", false
	}
	reason := s.reason
	s.reason = ""
	s.needsResync.Store(false)
	return reason, true
}

func (s *Subscription) close() {
	s.closeOnce.Do(func() { close(s.events) })
}

type subscriberSet struct {
	subs map[int]*Subscription
	// restartPending is set when the context's informers were invalidated while
	// it had subscribers; the next EnsureStarted sends them a resync.
	restartPending bool
}

// Manager manages per-context watch caches backed by dynamic informers.
type Manager struct {
	mu       sync.RWMutex
	contexts map[string]*contextCache

	// subMu guards subs. Subscribers outlive informer restarts (Invalidate) so
	// a client can be told to resync instead of being dropped.
	// Lock order: mu, then cc.mu, then subMu.
	subMu     sync.RWMutex
	subs      map[string]*subscriberSet
	nextSubID int

	hooksMu      sync.RWMutex
	unhealthy    func(contextName string) bool
	onWatchError func(contextName string, err error)

	// Test seams.
	subBuffer   int
	now         func() time.Time
	idleTTL     time.Duration
	janitorTick time.Duration

	janitorMu   sync.Mutex
	janitorStop chan struct{}
	janitorDone chan struct{}
}

// SetHealthHooks wires context health into the cache. unhealthy makes ListAll
// report synced=false so callers fall back to the API (and surface the error)
// instead of serving stale data; onWatchError receives informer list/watch errors.
func (m *Manager) SetHealthHooks(unhealthy func(contextName string) bool, onWatchError func(contextName string, err error)) {
	m.hooksMu.Lock()
	defer m.hooksMu.Unlock()
	m.unhealthy = unhealthy
	m.onWatchError = onWatchError
}

func (m *Manager) isUnhealthy(contextName string) bool {
	m.hooksMu.RLock()
	fn := m.unhealthy
	m.hooksMu.RUnlock()
	return fn != nil && fn(contextName)
}

func (m *Manager) reportWatchError(contextName string, err error) {
	m.hooksMu.RLock()
	fn := m.onWatchError
	m.hooksMu.RUnlock()
	if fn != nil {
		fn(contextName, err)
	}
}

// New creates a new Manager.
func New() *Manager {
	return &Manager{
		contexts:    make(map[string]*contextCache),
		subs:        make(map[string]*subscriberSet),
		subBuffer:   defaultSubscriberBuffer,
		now:         time.Now,
		idleTTL:     defaultIdleTTL,
		janitorTick: defaultJanitorTick,
	}
}

// EnsureStarted is idempotent and safe for concurrent calls (including with
// Invalidate/StopAll). It creates a factory if absent, registers any new GVRs,
// and calls factory.Start().
func (m *Manager) EnsureStarted(contextName string, dynClient dynamic.Interface, resources []disc.ResourceInfo) {
	for {
		m.mu.Lock()
		cc, ok := m.contexts[contextName]
		created := false
		if !ok {
			cc = &contextCache{
				factory: dynamicinformer.NewDynamicSharedInformerFactory(dynClient, 0),
				stopCh:  make(chan struct{}),
				gvrs:    make(map[schema.GroupVersionResource]*gvrEntry),
			}
			cc.touch(m.now())
			m.contexts[contextName] = cc
			created = true
		}
		m.mu.Unlock()

		cc.mu.Lock()
		if cc.stopped.Load() {
			// Invalidated between lookup and lock; retry with a fresh cache.
			cc.mu.Unlock()
			continue
		}
		cc.touch(m.now())
		for _, r := range resources {
			gvr := schema.GroupVersionResource{Group: r.Group, Version: r.Version, Resource: r.Resource}
			if _, exists := cc.gvrs[gvr]; !exists {
				inf := cc.factory.ForResource(gvr)
				_ = inf.Informer().SetWatchErrorHandlerWithContext(func(ctx context.Context, r *kcache.Reflector, err error) {
					if !cc.stopped.Load() {
						m.reportWatchError(contextName, err)
					}
					kcache.DefaultWatchErrorHandler(ctx, r, err)
				})
				_, _ = inf.Informer().AddEventHandler(kcache.ResourceEventHandlerFuncs{
					AddFunc: func(obj any) {
						m.broadcast(cc, contextName, gvr, "add", obj)
					},
					UpdateFunc: func(_, newObj any) {
						m.broadcast(cc, contextName, gvr, "update", newObj)
					},
					DeleteFunc: func(obj any) {
						m.broadcast(cc, contextName, gvr, "delete", obj)
					},
				})
				cc.gvrs[gvr] = &gvrEntry{informer: inf}
			}
		}
		// factory.Start is safe to call multiple times; it only launches
		// goroutines for informers not yet started. Holding cc.mu (with
		// stopped unset) guarantees stopCh is still open.
		cc.factory.Start(cc.stopCh)
		cc.mu.Unlock()

		if created {
			m.subMu.Lock()
			if set, ok := m.subs[contextName]; ok && set.restartPending {
				set.restartPending = false
				for _, sub := range set.subs {
					sub.MarkResync(ResyncReasonRestarted)
				}
			}
			m.subMu.Unlock()
		}
		return
	}
}

func (m *Manager) broadcast(cc *contextCache, contextName string, gvr schema.GroupVersionResource, verb string, obj any) {
	if cc.stopped.Load() {
		return // stale informer from an invalidated cache
	}
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
	m.deliver(contextName, ev)
}

// deliver fans an event out to the context's subscribers. A full subscriber
// buffer drops the event and flags a resync instead of blocking the informer.
func (m *Manager) deliver(contextName string, ev ResourceEvent) {
	m.subMu.RLock()
	defer m.subMu.RUnlock()
	set, ok := m.subs[contextName]
	if !ok {
		return
	}
	for _, sub := range set.subs {
		select {
		case sub.events <- ev:
		default:
			sub.MarkResync(ResyncReasonOverflow)
		}
	}
}

func toUnstructured(obj any) (*unstructured.Unstructured, bool) {
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

// Subscribe returns a best-effort stream of informer change notifications
// for a context whose informers have been started. ok is false otherwise.
func (m *Manager) Subscribe(contextName string) (*Subscription, bool) {
	m.mu.RLock()
	_, ok := m.contexts[contextName]
	m.mu.RUnlock()
	if !ok {
		return nil, false
	}

	m.subMu.Lock()
	defer m.subMu.Unlock()
	set, ok := m.subs[contextName]
	if !ok {
		set = &subscriberSet{subs: make(map[int]*Subscription)}
		m.subs[contextName] = set
	}
	id := m.nextSubID
	m.nextSubID++
	sub := &Subscription{
		events: make(chan ResourceEvent, m.subBuffer),
		notify: make(chan struct{}, 1),
	}
	set.subs[id] = sub
	sub.cancel = func() { m.unsubscribe(contextName, id) }
	return sub, true
}

func (m *Manager) unsubscribe(contextName string, id int) {
	m.subMu.Lock()
	var sub *Subscription
	if set, ok := m.subs[contextName]; ok {
		sub = set.subs[id]
		delete(set.subs, id)
		if len(set.subs) == 0 {
			delete(m.subs, contextName)
		}
	}
	if sub != nil {
		sub.close()
	}
	m.subMu.Unlock()
	if sub == nil {
		return
	}
	// Start the idle clock from when the client left.
	m.mu.RLock()
	if cc, ok := m.contexts[contextName]; ok {
		cc.touch(m.now())
	}
	m.mu.RUnlock()
}

// SubscriberCount returns the number of live subscribers for a context.
func (m *Manager) SubscriberCount(contextName string) int {
	m.subMu.RLock()
	defer m.subMu.RUnlock()
	if set, ok := m.subs[contextName]; ok {
		return len(set.subs)
	}
	return 0
}

// RequestResync flags every subscriber of a context to refetch.
func (m *Manager) RequestResync(contextName, reason string) {
	m.subMu.RLock()
	defer m.subMu.RUnlock()
	if set, ok := m.subs[contextName]; ok {
		for _, sub := range set.subs {
			sub.MarkResync(reason)
		}
	}
}

// ListAll returns all items for the given GVR and namespace from the cache.
// synced=false means the informer is not yet warm; the caller should fall back to the API.
func (m *Manager) ListAll(contextName string, gvr schema.GroupVersionResource, namespace string) ([]unstructured.Unstructured, bool) {
	if m.isUnhealthy(contextName) {
		return nil, false
	}
	m.mu.RLock()
	cc, ok := m.contexts[contextName]
	m.mu.RUnlock()
	if !ok {
		return nil, false
	}

	cc.touch(m.now())

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

// stopLocked stops a context's informers. Caller holds m.mu (write).
func (m *Manager) stopLocked(contextName string, cc *contextCache) {
	cc.mu.Lock()
	cc.stopped.Store(true)
	close(cc.stopCh)
	cc.mu.Unlock()
	delete(m.contexts, contextName)
}

// Invalidate stops informers for a single context and removes it from the
// map (e.g. after re-import or re-authentication). Subscribers stay attached:
// the next EnsureStarted for the context sends them a resync, since they may
// have missed changes while informers were down.
func (m *Manager) Invalidate(contextName string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	cc, ok := m.contexts[contextName]
	if !ok {
		return
	}
	m.stopLocked(contextName, cc)
	m.subMu.Lock()
	if set, ok := m.subs[contextName]; ok && len(set.subs) > 0 {
		set.restartPending = true
	}
	m.subMu.Unlock()
}

// Remove stops a context's informers and closes its subscribers. Used when a
// context is deleted.
func (m *Manager) Remove(contextName string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if cc, ok := m.contexts[contextName]; ok {
		m.stopLocked(contextName, cc)
	}
	m.subMu.Lock()
	if set, ok := m.subs[contextName]; ok {
		for _, sub := range set.subs {
			sub.close()
		}
		delete(m.subs, contextName)
	}
	m.subMu.Unlock()
}

// StopAll stops every context and closes every subscriber. Used on store
// lock / reset / profile change.
func (m *Manager) StopAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for name, cc := range m.contexts {
		m.stopLocked(name, cc)
	}
	m.subMu.Lock()
	for name, set := range m.subs {
		for _, sub := range set.subs {
			sub.close()
		}
		delete(m.subs, name)
	}
	m.subMu.Unlock()
}

// StartJanitor launches a goroutine that periodically stops informers for
// contexts that have no subscribers, are not active (per isActive), and have
// been idle longer than the idle TTL. Calling it again is a no-op; Close
// stops it.
func (m *Manager) StartJanitor(isActive func(contextName string) bool) {
	m.janitorMu.Lock()
	defer m.janitorMu.Unlock()
	if m.janitorStop != nil {
		return
	}
	stop := make(chan struct{})
	done := make(chan struct{})
	m.janitorStop, m.janitorDone = stop, done
	tick := m.janitorTick
	go func() {
		defer close(done)
		t := time.NewTicker(tick)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				m.reapIdle(isActive)
			}
		}
	}()
}

// reapIdle stops idle, unwatched, non-active contexts and returns their names.
// The active context is never stopped.
func (m *Manager) reapIdle(isActive func(contextName string) bool) []string {
	now := m.now()
	m.mu.Lock()
	defer m.mu.Unlock()
	var reaped []string
	for name, cc := range m.contexts {
		if isActive == nil || isActive(name) {
			continue
		}
		if m.SubscriberCount(name) > 0 {
			continue
		}
		if now.Sub(time.Unix(0, cc.lastUsed.Load())) < m.idleTTL {
			continue
		}
		m.stopLocked(name, cc)
		reaped = append(reaped, name)
	}
	return reaped
}

// Close stops the janitor and all informers and subscribers.
func (m *Manager) Close() {
	m.janitorMu.Lock()
	stop, done := m.janitorStop, m.janitorDone
	m.janitorStop, m.janitorDone = nil, nil
	m.janitorMu.Unlock()
	if stop != nil {
		close(stop)
		<-done
	}
	m.StopAll()
}
