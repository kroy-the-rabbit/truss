package auth

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"net/url"
	"strings"
)

// GenerateToken creates a random bearer token for daemon auth.
func GenerateToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func isAllowedCORSOrigin(origin string) bool {
	if origin == "" || origin == "null" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if strings.EqualFold(u.Scheme, "file") {
		return true
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return false
	}
	switch strings.ToLower(u.Hostname()) {
	case "127.0.0.1", "localhost", "::1":
		return true
	default:
		return false
	}
}

func tokenFromWSProtocolHeader(protocolHeader string) string {
	if protocolHeader == "" {
		return ""
	}
	for _, item := range strings.Split(protocolHeader, ",") {
		p := strings.TrimSpace(item)
		if strings.HasPrefix(p, "truss-token-") {
			return strings.TrimPrefix(p, "truss-token-")
		}
	}
	return ""
}

// Middleware returns an HTTP middleware that validates bearer tokens
// and handles CORS for the Electron renderer.
func Middleware(token string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// CORS headers for cross-origin requests from Electron dev server.
			origin := r.Header.Get("Origin")
			if origin != "" && isAllowedCORSOrigin(origin) {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Connect-Protocol-Version")
				w.Header().Set("Access-Control-Max-Age", "86400")
				w.Header().Set("Vary", "Origin")
			} else if origin != "" && !isAllowedCORSOrigin(origin) {
				http.Error(w, "forbidden origin", http.StatusForbidden)
				return
			}

			// Handle preflight requests before auth check.
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}

			// WebSocket auth via Sec-WebSocket-Protocol header only.
			// Query-param fallback is intentionally omitted (token in URL appears in logs).
			if strings.HasPrefix(r.URL.Path, "/ws/") {
				wsToken := tokenFromWSProtocolHeader(r.Header.Get("Sec-WebSocket-Protocol"))
				if wsToken != token {
					http.Error(w, "unauthorized", http.StatusUnauthorized)
					return
				}
				next.ServeHTTP(w, r)
				return
			}

			auth := r.Header.Get("Authorization")
			if !strings.HasPrefix(auth, "Bearer ") || auth[7:] != token {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
