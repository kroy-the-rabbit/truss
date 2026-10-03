package server

import (
	"crypto/subtle"
	"net/http"
)

// authorizePluginStorage writes a 403 and returns false unless the request
// carries the main-process token (see mainonly.go). Only the Electron main
// process knows it, so plugin code running in a renderer cannot call the
// secure-storage endpoints directly even though it can obtain the general
// daemon bearer token. Main binds plugin_id to an unforgeable per-plugin
// capability and only forwards requests for approved plugins.
func (s *Server) authorizePluginStorage(w http.ResponseWriter, r *http.Request) bool {
	want := s.currentMainToken()
	got := r.Header.Get(MainTokenHeader)
	if want == "" || got == "" || subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "plugin storage is only available through the Truss main process"})
		return false
	}
	return true
}
