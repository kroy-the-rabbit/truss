package server

import (
	"crypto/subtle"
	"net/http"
)

// PluginStorageTokenHeader carries the secret that authorises a caller to use
// the plugin secure-storage endpoints. Only the Electron main process knows it
// (it is handed to trussd via the TRUSS_PLUGIN_STORAGE_TOKEN env var and never
// exposed to renderers), so plugin code running in a renderer cannot call these
// endpoints directly even though it can obtain the general daemon bearer token.
// Main binds plugin_id to an unforgeable per-plugin capability and only
// forwards requests for approved plugins.
const PluginStorageTokenHeader = "X-Truss-Plugin-Storage-Token"

// SetPluginStorageToken configures the secret required by the plugin
// secure-storage endpoints. An empty token disables those endpoints entirely
// (fail closed), which is the state of a daemon started without Electron.
// Call before Start.
func (s *Server) SetPluginStorageToken(token string) {
	s.pluginStorageToken = token
}

// authorizePluginStorage writes a 403 and returns false unless the request
// carries the plugin storage token.
func (s *Server) authorizePluginStorage(w http.ResponseWriter, r *http.Request) bool {
	want := s.pluginStorageToken
	got := r.Header.Get(PluginStorageTokenHeader)
	if want == "" || got == "" || subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "plugin storage is only available through the Truss main process"})
		return false
	}
	return true
}
