package server

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/kroy/truss/backend/internal/portforward"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// Port-forwarding runs in the daemon with the vault context's credentials.
// It is not a cluster mutation, so it is allowed in read-only mode.
//
//	POST /api/portforward/start {context, namespace, kind, name, remote_port, local_port} -> forward
//	POST /api/portforward/stop  {id} -> forward (final snapshot)
//	GET  /api/portforward       -> {"forwards": [...]}
//	GET  /api/portforward/suggest-port?context=&namespace=&kind=&name= -> {"port": n} (0 = none)

func newPortForwardManager(s *Server) *portforward.Manager {
	return portforward.NewManager(func(contextName string) (kubernetes.Interface, *rest.Config, error) {
		// GetClientSet applies the auth circuit breaker and exec approval.
		cs, err := s.kubeMgr.GetClientSet(contextName)
		if err != nil {
			return nil, nil, err
		}
		return cs.Clientset, cs.Config, nil
	}, nil)
}

func (s *Server) registerPortForwardRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/portforward", s.handlePortForwardList)
	mux.HandleFunc("/api/portforward/start", s.handlePortForwardStart)
	mux.HandleFunc("/api/portforward/stop", s.handlePortForwardStop)
	mux.HandleFunc("/api/portforward/suggest-port", s.handlePortForwardSuggestPort)
}

func (s *Server) handlePortForwardSuggestPort(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	q := r.URL.Query()
	namespace, name, kind := q.Get("namespace"), q.Get("name"), q.Get("kind")
	if namespace == "" || name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "namespace and name are required"})
		return
	}
	cs, err := s.kubeMgr.GetClientSet(s.resolveContext(q.Get("context")))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 6*time.Second)
	defer cancel()
	port, err := portforward.SuggestPort(ctx, cs.Clientset, kind, namespace, name)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"port": port})
}

// stopAllPortForwards ends every forward; called on lock, reset, profile
// switch and shutdown, where the credentials they use stop being valid.
func (s *Server) stopAllPortForwards() {
	if s.portForwards != nil {
		s.portForwards.StopAll()
	}
}

// stopContextPortForwards ends forwards for a context that was deleted.
func (s *Server) stopContextPortForwards(contextName string) {
	if s.portForwards != nil {
		s.portForwards.StopContext(contextName)
	}
}

func (s *Server) handlePortForwardList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"forwards": s.portForwards.List()})
}

func (s *Server) handlePortForwardStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		portforward.Target
		LocalPort int `json:"local_port"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if !s.store.IsInitialized() || s.store.IsLocked() {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "store is locked"})
		return
	}
	body.Context = s.resolveContext(body.Context)
	if body.Context == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "context is required"})
		return
	}
	info, err := s.portForwards.Start(r.Context(), body.Target, body.LocalPort)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, info)
}

func (s *Server) handlePortForwardStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id is required"})
		return
	}
	info, ok := s.portForwards.Stop(body.ID)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "port-forward not found"})
		return
	}
	writeJSON(w, http.StatusOK, info)
}
