package server

// MainTokenHeader carries the main-process-only credential. The renderer never
// sees this token (it is passed to trussd via TRUSS_MAIN_TOKEN and kept in the
// Electron main process), and auth.Middleware's CORS allow-list deliberately
// does not include this header. Plugin secure storage requires it; see
// plugin_storage_auth.go.
const MainTokenHeader = "X-Truss-Main-Token"

// SetMainToken configures the main-process-only credential. An empty token
// disables every endpoint that requires it (they answer 403).
func (s *Server) SetMainToken(token string) {
	s.mainToken.Store(&token)
}

func (s *Server) currentMainToken() string {
	if p := s.mainToken.Load(); p != nil {
		return *p
	}
	return ""
}
