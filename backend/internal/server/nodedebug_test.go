package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestHandleNodeDebugMethodGuard verifies that handleNodeDebug rejects non-POST requests.
func TestHandleNodeDebugMethodGuard(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete, http.MethodPatch} {
		t.Run(method, func(t *testing.T) {
			srv := &Server{}
			r := httptest.NewRequest(method, "/api/nodes/debug", nil)
			w := httptest.NewRecorder()
			srv.handleNodeDebug(w, r)
			if w.Code != http.StatusMethodNotAllowed {
				t.Errorf("%s: expected 405, got %d", method, w.Code)
			}
		})
	}
}

// TestHandleNodeDebugMissingNode verifies that a missing node field returns 400.
func TestHandleNodeDebugMissingNode(t *testing.T) {
	srv := &Server{}
	body := `{"namespace":"default","image":"busybox"}`
	r := httptest.NewRequest(http.MethodPost, "/api/nodes/debug", jsonBody(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	srv.handleNodeDebug(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing node, got %d", w.Code)
	}
	checkErrorField(t, w.Body.Bytes())
}

// TestHandleNodeDebugInvalidJSON verifies that malformed JSON returns 400.
func TestHandleNodeDebugInvalidJSON(t *testing.T) {
	srv := &Server{}
	r := httptest.NewRequest(http.MethodPost, "/api/nodes/debug", jsonBody(`not json`))
	w := httptest.NewRecorder()
	srv.handleNodeDebug(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid JSON, got %d", w.Code)
	}
}

// TestHandleNodeDebugDeleteMethodGuard verifies that handleNodeDebugDelete rejects non-DELETE requests.
func TestHandleNodeDebugDeleteMethodGuard(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch} {
		t.Run(method, func(t *testing.T) {
			srv := &Server{}
			r := httptest.NewRequest(method, "/api/nodes/debug/delete?pod=test-pod&namespace=default", nil)
			w := httptest.NewRecorder()
			srv.handleNodeDebugDelete(w, r)
			if w.Code != http.StatusMethodNotAllowed {
				t.Errorf("%s: expected 405, got %d", method, w.Code)
			}
		})
	}
}

// TestHandleNodeDebugDeleteMissingPod verifies that a missing pod parameter returns 400.
// context=test is required so resolveContext doesn't need an active kubeMgr.
func TestHandleNodeDebugDeleteMissingPod(t *testing.T) {
	srv := &Server{}
	r := httptest.NewRequest(http.MethodDelete, "/api/nodes/debug/delete?context=test&namespace=default", nil)
	w := httptest.NewRecorder()
	srv.handleNodeDebugDelete(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing pod, got %d", w.Code)
	}
	checkErrorField(t, w.Body.Bytes())
}

// checkErrorField asserts that the JSON body contains an "error" key.
func checkErrorField(t *testing.T, body []byte) {
	t.Helper()
	var m map[string]string
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("response body is not JSON: %v\nbody: %s", err, body)
	}
	if m["error"] == "" {
		t.Fatalf("expected non-empty 'error' field in response: %s", body)
	}
}

// jsonBody returns a strings.Reader wrapping the given JSON string.
func jsonBody(s string) *strings.Reader {
	return strings.NewReader(s)
}
