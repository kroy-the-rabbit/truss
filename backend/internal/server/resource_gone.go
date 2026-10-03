package server

import (
	"time"

	"k8s.io/apimachinery/pkg/runtime/schema"
)

// resourceGoneMinInterval limits how often one context's informers are
// rebuilt in response to resources disappearing from the server.
const resourceGoneMinInterval = time.Minute

// handleResourceGone runs when an informer's resource is no longer served
// (e.g. a CRD version was removed). It refreshes discovery and, if the
// resource is really gone, restarts the context's informers without it so the
// daemon stops retrying a 404 forever.
func (s *Server) handleResourceGone(contextName string, gvr schema.GroupVersionResource) {
	s.goneMu.Lock()
	if s.goneLast == nil {
		s.goneLast = make(map[string]time.Time)
	}
	if last, ok := s.goneLast[contextName]; ok && time.Since(last) < resourceGoneMinInterval {
		s.goneMu.Unlock()
		return
	}
	s.goneLast[contextName] = time.Now()
	s.goneMu.Unlock()

	cs, err := s.kubeMgr.GetClientSet(contextName)
	if err != nil {
		return
	}
	resources, err := s.discoveryCache.Discover(contextName, cs.Discovery, true)
	if err != nil {
		return
	}
	for _, r := range resources {
		if r.Group == gvr.Group && r.Version == gvr.Version && r.Resource == gvr.Resource && r.Watchable() {
			return // still served; the failure was transient
		}
	}
	// Invalidate keeps subscribers attached; the restart sends them a resync.
	s.watchCache.Invalidate(contextName)
	s.watchCache.EnsureStarted(contextName, cs.InformerClient(), resources)
}
