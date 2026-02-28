package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGenerateToken(t *testing.T) {
	tok, err := GenerateToken()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(tok) != 64 {
		t.Fatalf("expected 64-char hex token, got %d chars: %q", len(tok), tok)
	}
	for _, c := range tok {
		if !strings.ContainsRune("0123456789abcdef", c) {
			t.Fatalf("non-hex char %q in token %q", c, tok)
		}
	}

	// Two calls must produce different tokens.
	tok2, err := GenerateToken()
	if err != nil {
		t.Fatalf("second call failed: %v", err)
	}
	if tok == tok2 {
		t.Fatal("GenerateToken returned identical tokens on two calls")
	}
}

func TestIsAllowedCORSOrigin(t *testing.T) {
	tests := []struct {
		origin string
		want   bool
	}{
		// Always allowed
		{"", true},
		{"null", true},
		{"file:///path/to/app.html", true},
		{"FILE:///upper-case", true},
		// Loopback HTTP/HTTPS
		{"http://localhost", true},
		{"http://localhost:3000", true},
		{"https://localhost:8443", true},
		{"http://127.0.0.1", true},
		{"http://127.0.0.1:9000", true},
		{"http://[::1]:8080", true},
		// Denied
		{"https://example.com", false},
		{"https://evil.localhost.com", false},
		{"ftp://localhost", false},
		{"://bad", false},
	}
	for _, tt := range tests {
		got := isAllowedCORSOrigin(tt.origin)
		if got != tt.want {
			t.Errorf("isAllowedCORSOrigin(%q) = %v, want %v", tt.origin, got, tt.want)
		}
	}
}

func TestTokenFromWSProtocolHeader(t *testing.T) {
	tests := []struct {
		header string
		want   string
	}{
		{"", ""},
		{"other-protocol", ""},
		{"truss-token-abc123", "abc123"},
		{"graphql-ws, truss-token-xyz, other", "xyz"},
		{" truss-token-pad , something", "pad"},
		{"truss-token-", ""},
	}
	for _, tt := range tests {
		got := tokenFromWSProtocolHeader(tt.header)
		if got != tt.want {
			t.Errorf("tokenFromWSProtocolHeader(%q) = %q, want %q", tt.header, got, tt.want)
		}
	}
}

// okHandler is the wrapped downstream that returns 200.
var okHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
})

const testToken = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"

func TestMiddlewareBearerToken(t *testing.T) {
	mw := Middleware(testToken)(okHandler)

	t.Run("valid token passes", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodGet, "/api/resources", nil)
		r.Header.Set("Authorization", "Bearer "+testToken)
		w := httptest.NewRecorder()
		mw.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", w.Code)
		}
	})

	t.Run("wrong token rejected", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodGet, "/api/resources", nil)
		r.Header.Set("Authorization", "Bearer wrong-token")
		w := httptest.NewRecorder()
		mw.ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %d", w.Code)
		}
	})

	t.Run("missing auth rejected", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodGet, "/api/resources", nil)
		w := httptest.NewRecorder()
		mw.ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %d", w.Code)
		}
	})

	t.Run("Basic scheme rejected", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodGet, "/api/resources", nil)
		r.Header.Set("Authorization", "Basic dXNlcjpwYXNz")
		w := httptest.NewRecorder()
		mw.ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %d", w.Code)
		}
	})
}

func TestMiddlewareCORSPreflight(t *testing.T) {
	mw := Middleware(testToken)(okHandler)

	t.Run("OPTIONS with allowed origin returns 204", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodOptions, "/api/resources", nil)
		r.Header.Set("Origin", "http://localhost:3000")
		w := httptest.NewRecorder()
		mw.ServeHTTP(w, r)
		if w.Code != http.StatusNoContent {
			t.Fatalf("expected 204, got %d", w.Code)
		}
		if w.Header().Get("Access-Control-Allow-Origin") == "" {
			t.Fatal("missing Access-Control-Allow-Origin on preflight")
		}
	})

	t.Run("OPTIONS with disallowed origin returns 403", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodOptions, "/api/resources", nil)
		r.Header.Set("Origin", "https://evil.example.com")
		w := httptest.NewRecorder()
		mw.ServeHTTP(w, r)
		if w.Code != http.StatusForbidden {
			t.Fatalf("expected 403, got %d", w.Code)
		}
	})

	t.Run("GET with allowed origin sets CORS headers", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodGet, "/api/resources", nil)
		r.Header.Set("Origin", "file:///app.html")
		r.Header.Set("Authorization", "Bearer "+testToken)
		w := httptest.NewRecorder()
		mw.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", w.Code)
		}
		if got := w.Header().Get("Access-Control-Allow-Origin"); got != "file:///app.html" {
			t.Fatalf("expected ACAO=file:///app.html, got %q", got)
		}
	})
}

func TestMiddlewareWebSocket(t *testing.T) {
	mw := Middleware(testToken)(okHandler)

	t.Run("WS path with correct token passes", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodGet, "/ws/exec", nil)
		r.Header.Set("Sec-WebSocket-Protocol", "truss-token-"+testToken)
		w := httptest.NewRecorder()
		mw.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", w.Code)
		}
	})

	t.Run("WS path with wrong token rejected", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodGet, "/ws/logs", nil)
		r.Header.Set("Sec-WebSocket-Protocol", "truss-token-badtoken")
		w := httptest.NewRecorder()
		mw.ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %d", w.Code)
		}
	})

	t.Run("WS path with no protocol header rejected", func(t *testing.T) {
		r := httptest.NewRequest(http.MethodGet, "/ws/logs", nil)
		w := httptest.NewRecorder()
		mw.ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %d", w.Code)
		}
	})

	t.Run("WS path ignores Bearer header", func(t *testing.T) {
		// Bearer in Authorization must NOT grant access to /ws/ paths.
		r := httptest.NewRequest(http.MethodGet, "/ws/exec", nil)
		r.Header.Set("Authorization", "Bearer "+testToken)
		w := httptest.NewRecorder()
		mw.ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401 for WS path without Sec-WebSocket-Protocol, got %d", w.Code)
		}
	})
}
