package server

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

// MainTokenHeader carries the main-process-only credential. The renderer never
// sees this token (it is passed to trussd via TRUSS_MAIN_TOKEN and kept in the
// Electron main process), and auth.Middleware's CORS allow-list deliberately
// does not include this header.
const MainTokenHeader = "X-Truss-Main-Token"

// SetMainToken configures the main-process-only credential. An empty token
// disables every main-only endpoint (they answer 403).
func (s *Server) SetMainToken(token string) {
	s.mainToken.Store(&token)
}

func (s *Server) currentMainToken() string {
	if p := s.mainToken.Load(); p != nil {
		return *p
	}
	return ""
}

// requireMainToken wraps a handler so it only runs when the request carries
// the main-process token. This is in addition to the normal bearer token,
// which auth.Middleware enforces for every request before this runs.
func (s *Server) requireMainToken(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		want := s.currentMainToken()
		if want == "" {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "main-only endpoints are disabled"})
			return
		}
		got := r.Header.Get(MainTokenHeader)
		if got == "" || subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		next(w, r)
	}
}

// exportClientCheck builds (or reuses) the context's client before anything
// is exported, so the kube.Manager gates (exec-plugin approval, auth circuit
// breaker) apply to exports exactly as they do to in-app access. It is a
// package variable only so tests can substitute a fake.
var exportClientCheck = func(s *Server, contextName string) error {
	_, err := s.kubeMgr.GetClientSet(contextName)
	return err
}

// handleExportKubeconfig returns a minimal kubeconfig for one vault context:
// only that context, its cluster and its user, with current-context set.
// The output contains credentials; it must never be logged.
func (s *Server) handleExportKubeconfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	var req struct {
		Context string `json:"context"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	name := strings.TrimSpace(req.Context)
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "context is required"})
		return
	}
	if !s.store.IsInitialized() || s.store.IsLocked() {
		writeJSON(w, http.StatusLocked, map[string]string{"error": "store is locked"})
		return
	}
	if err := exportClientCheck(s, name); err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	entry, ok := s.store.GetContextEntry(name)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "context not found"})
		return
	}
	out, err := minimalKubeconfig(entry.Kubeconfig, name)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"kubeconfig": out})
}

// minimalKubeconfig reduces a stored kubeconfig to the context it selects
// (its current-context, matching how kube.Manager builds clients), renamed to
// the vault key so the exported file's current-context is the vault name.
func minimalKubeconfig(kubeconfigYAML, vaultName string) (string, error) {
	cfg, err := clientcmd.Load([]byte(kubeconfigYAML))
	if err != nil {
		return "", fmt.Errorf("parsing stored kubeconfig: %w", err)
	}
	ctx := cfg.Contexts[cfg.CurrentContext]
	if ctx == nil {
		return "", fmt.Errorf("stored kubeconfig has no current context")
	}
	cluster := cfg.Clusters[ctx.Cluster]
	if cluster == nil {
		return "", fmt.Errorf("stored kubeconfig is missing its cluster")
	}
	user := cfg.AuthInfos[ctx.AuthInfo]
	if user == nil {
		user = clientcmdapi.NewAuthInfo()
	}
	minimal := clientcmdapi.NewConfig()
	minimal.CurrentContext = vaultName
	minimal.Contexts[vaultName] = ctx
	minimal.Clusters[ctx.Cluster] = cluster
	minimal.AuthInfos[ctx.AuthInfo] = user
	b, err := clientcmd.Write(*minimal)
	if err != nil {
		return "", fmt.Errorf("serializing kubeconfig: %w", err)
	}
	return string(b), nil
}
