package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/kroy/truss/backend/internal/kube"
)

// importedContext is the per-context result of POST /api/contexts/import.
type importedContext struct {
	Name             string              `json:"name"`
	RequiresApproval bool                `json:"requires_approval"`
	Sensitive        *kube.SensitiveAuth `json:"sensitive,omitempty"`
}

// importedContextResult reports whether a just-imported context needs exec
// approval. When it does, EXEC_APPROVAL_REQUIRED health is recorded (without
// building a client) so every window shows the approval banner. A kubeconfig
// that cannot be parsed is reported as requiring approval so nothing runs.
func importedContextResult(m *kube.Manager, name string) importedContext {
	out := importedContext{Name: name}
	sens, err := m.CheckExecApproval(name)
	if sens != nil && sens.IsSensitive() {
		out.Sensitive = sens
	}
	if err != nil {
		out.RequiresApproval = true
	}
	return out
}

func decodePOST(w http.ResponseWriter, r *http.Request, dst any) bool {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return false
	}
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return false
	}
	return true
}

// resetContextCaches drops every cached artefact of a context (informers,
// discovery, search index) so nothing keeps using a client built under a
// previous approval.
func (s *Server) resetContextCaches(name string) {
	if s.watchCache != nil {
		s.watchCache.Invalidate(name)
	}
	if s.discoveryCache != nil {
		s.discoveryCache.Invalidate(name)
	}
	s.searchMu.Lock()
	delete(s.searchIndexes, name)
	s.searchMu.Unlock()
}

// POST /api/contexts/approve-exec {"context":NAME,"fingerprint":HEX}
//
// The fingerprint must equal the context's current one, so a user cannot
// approve a stale view of a command that has since changed. On success it
// behaves like /api/contexts/reauth and returns the probed ContextHealth.
func (s *Server) handleContextApproveExec(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Context     string `json:"context"`
		Fingerprint string `json:"fingerprint"`
	}
	if !decodePOST(w, r, &body) {
		return
	}
	name := strings.TrimSpace(body.Context)
	if name == "" || strings.TrimSpace(body.Fingerprint) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "context and fingerprint are required"})
		return
	}
	if _, ok := s.store.GetContextEntry(name); !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "context not found"})
		return
	}
	if err := s.kubeMgr.ApproveExec(name, body.Fingerprint); err != nil {
		status := http.StatusInternalServerError
		switch {
		case errors.Is(err, kube.ErrFingerprintMismatch):
			status = http.StatusConflict
		case errors.Is(err, kube.ErrNothingToApprove):
			status = http.StatusBadRequest
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}

	s.resetContextCaches(name)
	health := s.kubeMgr.Reauth(name)
	if health.State == kube.StateOK {
		s.triggerSearchIndexRefresh(name)
		if s.watchCache != nil {
			s.restartWatchedInformers(name)
		}
	}
	writeJSON(w, http.StatusOK, health)
}

// POST /api/contexts/revoke-exec {"context":NAME}
func (s *Server) handleContextRevokeExec(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Context string `json:"context"`
	}
	if !decodePOST(w, r, &body) {
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
	if err := s.kubeMgr.RevokeExec(name); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	s.resetContextCaches(name)
	// Records EXEC_APPROVAL_REQUIRED (when sensitive) so the banner updates.
	_, _ = s.kubeMgr.CheckExecApproval(name)
	writeJSON(w, http.StatusOK, s.kubeMgr.Health(name))
}

// GET /api/contexts/exec-approvals
//
// {"contexts":[{"name","approved":bool,"sensitive":{...}}]} for every stored
// context in the active profile that runs a command or reads local files.
func (s *Server) handleContextExecApprovals(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	type item struct {
		Name      string              `json:"name"`
		Approved  bool                `json:"approved"`
		Sensitive *kube.SensitiveAuth `json:"sensitive"`
	}
	out := []item{}
	for _, name := range s.kubeMgr.ContextNames() {
		sens, approved, err := s.kubeMgr.ExecApproval(name)
		if err != nil || sens == nil || !sens.IsSensitive() {
			continue
		}
		out = append(out, item{Name: name, Approved: approved, Sensitive: sens})
	}
	writeJSON(w, http.StatusOK, map[string]any{"contexts": out})
}
