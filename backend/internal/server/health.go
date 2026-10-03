package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"connectrpc.com/connect"
	"github.com/kroy/truss/backend/internal/kube"
	"github.com/kroy/truss/backend/internal/watchcache"
)

// newHealthAwareWatchCache wires context health into a new watch cache: reads
// bypass the cache while a context is in an error state, and informer
// list/watch failures are recorded against the context.
func newHealthAwareWatchCache(kubeMgr *kube.Manager) *watchcache.Manager {
	wc := watchcache.New()
	if kubeMgr != nil {
		wc.SetHealthHooks(kubeMgr.InErrorState, func(contextName string, err error) {
			// Per-GVR RBAC denials are expected for restricted users; they do
			// not describe the context as a whole.
			if kube.Classify(err) == kube.KindForbidden {
				return
			}
			kubeMgr.RecordError(contextName, err)
		})
	}
	return wc
}

// toConnectError converts a cluster error to a Connect error with a code that
// reflects its classification (and records it against the context's health).
func (s *Server) toConnectError(contextName string, err error) error {
	return s.toConnectErrorDefault(contextName, err, connect.CodeInternal)
}

// toConnectErrorDefault is toConnectError with a caller-chosen code for
// UNKNOWN errors (e.g. CodeNotFound for "get" calls).
func (s *Server) toConnectErrorDefault(contextName string, err error, fallback connect.Code) error {
	if err == nil {
		return nil
	}
	kind := kube.Classify(err)
	if s.kubeMgr != nil && kind != kube.KindForbidden {
		s.kubeMgr.RecordError(contextName, err)
	}
	code := fallback
	switch {
	case kind.IsAuth():
		code = connect.CodeUnauthenticated
		var ae *kube.AuthError
		if !errors.As(err, &ae) {
			err = errors.New(kube.HealthMessage(contextName, kind, err))
		}
	case kind == kube.KindForbidden:
		code = connect.CodePermissionDenied
	case kind == kube.KindUnreachable, kind == kube.KindTLS:
		code = connect.CodeUnavailable
	}
	return connect.NewError(code, err)
}

// authBlockedHealth returns the context's health when its auth breaker is open.
func (s *Server) authBlockedHealth(contextName string) (kube.ContextHealth, bool) {
	if s.kubeMgr == nil {
		return kube.ContextHealth{}, false
	}
	h := s.kubeMgr.Health(contextName)
	return h, h.State == kube.StateError && h.Kind.IsAuth()
}

func writeAuthBlocked(w http.ResponseWriter, h kube.ContextHealth) {
	writeJSON(w, http.StatusUnauthorized, map[string]string{
		"error": h.Message,
		"kind":  string(h.Kind),
	})
}

// healthWatchMessage encodes a health transition for the /ws/watch stream.
func healthWatchMessage(h kube.ContextHealth) []byte {
	b, _ := json.Marshal(struct {
		Type   string             `json:"type"`
		Health kube.ContextHealth `json:"health"`
	}{Type: "health", Health: h})
	return b
}

// GET /api/context-health[?context=NAME]
func (s *Server) handleContextHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name := strings.TrimSpace(r.URL.Query().Get("context"))
	if name == "" {
		writeJSON(w, http.StatusOK, map[string]any{"contexts": s.kubeMgr.AllHealth()})
		return
	}
	writeJSON(w, http.StatusOK, s.kubeMgr.Health(name))
}

// POST /api/contexts/reauth {"context":NAME}
func (s *Server) handleContextReauth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Context string `json:"context"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	name := strings.TrimSpace(body.Context)
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "context is required"})
		return
	}
	if _, ok := s.store.GetContextEntry(name); !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "context not found"})
		return
	}

	if s.watchCache != nil {
		s.watchCache.Invalidate(name)
	}
	if s.discoveryCache != nil {
		s.discoveryCache.Invalidate(name)
	}
	s.searchMu.Lock()
	delete(s.searchIndexes, name)
	s.searchMu.Unlock()

	health := s.kubeMgr.Reauth(name)
	if health.State == kube.StateOK {
		s.triggerSearchIndexRefresh(name)
	}
	writeJSON(w, http.StatusOK, health)
}
