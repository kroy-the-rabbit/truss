package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/kroy/truss/backend/internal/contextstore"
	"github.com/kroy/truss/backend/internal/kube"
	"github.com/kroy/truss/backend/internal/watchcache"
)

// toJSONBody marshals v to JSON and returns an *bytes.Buffer for use as HTTP request body.
func toJSONBody(t *testing.T, v any) *bytes.Buffer {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	return bytes.NewBuffer(b)
}

// newSetupServer creates a Server with a fresh uninitialized store, a real
// kube.Manager (needed by refreshAfterProfileChange / ClearAllClients), and
// a watchCache.  The store is isolated in a temp directory.
func newSetupServer(t *testing.T) *Server {
	t.Helper()
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("XDG_CONFIG_HOME", tmp)
	store, err := contextstore.New()
	if err != nil {
		t.Fatalf("contextstore.New: %v", err)
	}
	mgr := kube.NewManager(store)
	return &Server{
		store:         store,
		kubeMgr:       mgr,
		watchCache:    watchcache.New(),
		searchIndexes: make(map[string]*searchIndexState),
	}
}

// initStore initialises the server's store with a password method.
func initStore(t *testing.T, s *Server, password string) {
	t.Helper()
	if err := s.store.Initialize("password", "", password); err != nil {
		t.Fatalf("store.Initialize: %v", err)
	}
}

// ---------------------------------------------------------------------------
// handleSetupStatus
// ---------------------------------------------------------------------------

func TestHandleSetupStatusUninitialised(t *testing.T) {
	s := newSetupServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/setup-status", nil)
	rr := httptest.NewRecorder()
	s.handleSetupStatus(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["initialized"] != false {
		t.Errorf("initialized = %v, want false", body["initialized"])
	}
	if body["locked"] != false {
		t.Errorf("locked = %v, want false for uninitialized store", body["locked"])
	}
}

func TestHandleSetupStatusInitialised(t *testing.T) {
	s := newSetupServer(t)
	initStore(t, s, "correct-horse-battery-staple")
	req := httptest.NewRequest(http.MethodGet, "/api/setup-status", nil)
	rr := httptest.NewRecorder()
	s.handleSetupStatus(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["initialized"] != true {
		t.Errorf("initialized = %v, want true", body["initialized"])
	}
}

// ---------------------------------------------------------------------------
// handleSetupInitialize
// ---------------------------------------------------------------------------

func TestHandleSetupInitializeMethodGuard(t *testing.T) {
	s := newSetupServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/setup/initialize", nil)
	rr := httptest.NewRecorder()
	s.handleSetupInitialize(rr, req)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", rr.Code)
	}
}

func TestHandleSetupInitializeBadJSON(t *testing.T) {
	s := newSetupServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/setup/initialize", bytes.NewBufferString("{bad"))
	rr := httptest.NewRecorder()
	s.handleSetupInitialize(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rr.Code)
	}
}

func TestHandleSetupInitializeShortPassword(t *testing.T) {
	s := newSetupServer(t)
	body := map[string]string{"method": "password", "password": "short"}
	req := httptest.NewRequest(http.MethodPost, "/api/setup/initialize", toJSONBody(t, body))
	rr := httptest.NewRecorder()
	s.handleSetupInitialize(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rr.Code)
	}
}

func TestHandleSetupInitializeSuccess(t *testing.T) {
	s := newSetupServer(t)
	body := map[string]string{"method": "password", "password": "correct-horse-battery-staple"}
	req := httptest.NewRequest(http.MethodPost, "/api/setup/initialize", toJSONBody(t, body))
	rr := httptest.NewRecorder()
	s.handleSetupInitialize(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	if !s.store.IsInitialized() {
		t.Error("store should be initialized after success")
	}
}

func TestHandleSetupInitializeAlreadyInitialized(t *testing.T) {
	s := newSetupServer(t)
	initStore(t, s, "correct-horse-battery-staple")
	// Second call should fail.
	body := map[string]string{"method": "password", "password": "correct-horse-battery-staple"}
	req := httptest.NewRequest(http.MethodPost, "/api/setup/initialize", toJSONBody(t, body))
	rr := httptest.NewRecorder()
	s.handleSetupInitialize(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for already-initialized", rr.Code)
	}
}

// ---------------------------------------------------------------------------
// handleSetupUnlock
// ---------------------------------------------------------------------------

func TestHandleSetupUnlockMethodGuard(t *testing.T) {
	s := newSetupServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/setup/unlock", nil)
	rr := httptest.NewRecorder()
	s.handleSetupUnlock(rr, req)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", rr.Code)
	}
}

func TestHandleSetupUnlockBadJSON(t *testing.T) {
	s := newSetupServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/setup/unlock", bytes.NewBufferString("{bad"))
	rr := httptest.NewRecorder()
	s.handleSetupUnlock(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rr.Code)
	}
}

func TestHandleSetupUnlockWrongPassword(t *testing.T) {
	s := newSetupServer(t)
	initStore(t, s, "correct-horse-battery-staple")
	if err := s.store.Lock(); err != nil {
		t.Fatalf("Lock: %v", err)
	}
	body := map[string]string{"password": "wrong-password"}
	req := httptest.NewRequest(http.MethodPost, "/api/setup/unlock", toJSONBody(t, body))
	rr := httptest.NewRecorder()
	s.handleSetupUnlock(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rr.Code)
	}
}

func TestHandleSetupUnlockNotLocked(t *testing.T) {
	// Unlock when store is not locked → Unlock() returns "store is not locked" → 401.
	s := newSetupServer(t)
	initStore(t, s, "correct-horse-battery-staple")
	// Store is initialized but not locked.
	body := map[string]string{"password": "correct-horse-battery-staple"}
	req := httptest.NewRequest(http.MethodPost, "/api/setup/unlock", toJSONBody(t, body))
	rr := httptest.NewRecorder()
	s.handleSetupUnlock(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401 (not locked)", rr.Code)
	}
}

// ---------------------------------------------------------------------------
// handleSetupLock
// ---------------------------------------------------------------------------

func TestHandleSetupLockMethodGuard(t *testing.T) {
	s := newSetupServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/setup/lock", nil)
	rr := httptest.NewRecorder()
	s.handleSetupLock(rr, req)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", rr.Code)
	}
}

func TestHandleSetupLockNotInitialized(t *testing.T) {
	s := newSetupServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/setup/lock", nil)
	rr := httptest.NewRecorder()
	s.handleSetupLock(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 (not initialized)", rr.Code)
	}
}

func TestHandleSetupLockSuccess(t *testing.T) {
	s := newSetupServer(t)
	initStore(t, s, "correct-horse-battery-staple")
	req := httptest.NewRequest(http.MethodPost, "/api/setup/lock", nil)
	rr := httptest.NewRecorder()
	s.handleSetupLock(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	if !s.store.IsLocked() {
		t.Error("store should be locked after handleSetupLock")
	}
}

// ---------------------------------------------------------------------------
// handleSetupReset
// ---------------------------------------------------------------------------

func TestHandleSetupResetMethodGuard(t *testing.T) {
	s := newSetupServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/setup/reset", nil)
	rr := httptest.NewRecorder()
	s.handleSetupReset(rr, req)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", rr.Code)
	}
}

func TestHandleSetupResetSuccess(t *testing.T) {
	s := newSetupServer(t)
	initStore(t, s, "correct-horse-battery-staple")
	req := httptest.NewRequest(http.MethodPost, "/api/setup/reset", nil)
	rr := httptest.NewRecorder()
	s.handleSetupReset(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
	if s.store.IsInitialized() {
		t.Error("store should be uninitialized after reset")
	}
}

// ---------------------------------------------------------------------------
// handleSetupPreferences
// ---------------------------------------------------------------------------

func TestHandleSetupPreferencesMethodGuard(t *testing.T) {
	s := newSetupServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/setup/preferences", nil)
	rr := httptest.NewRecorder()
	s.handleSetupPreferences(rr, req)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", rr.Code)
	}
}

func TestHandleSetupPreferencesStoreNotReady(t *testing.T) {
	s := newSetupServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/setup/preferences", nil)
	rr := httptest.NewRecorder()
	s.handleSetupPreferences(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 (not initialized)", rr.Code)
	}
}

func TestHandleSetupPreferencesSuccess(t *testing.T) {
	s := newSetupServer(t)
	initStore(t, s, "correct-horse-battery-staple")
	req := httptest.NewRequest(http.MethodGet, "/api/setup/preferences", nil)
	rr := httptest.NewRecorder()
	s.handleSetupPreferences(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rr.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(rr.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if _, ok := body["auto_lock_minutes"]; !ok {
		t.Error("response missing auto_lock_minutes")
	}
}

// ---------------------------------------------------------------------------
// handleSetupAutoLockSet
// ---------------------------------------------------------------------------

func TestHandleSetupAutoLockSetMethodGuard(t *testing.T) {
	s := newSetupServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/setup/auto-lock", nil)
	rr := httptest.NewRecorder()
	s.handleSetupAutoLockSet(rr, req)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", rr.Code)
	}
}

func TestHandleSetupAutoLockSetBadJSON(t *testing.T) {
	s := newSetupServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/setup/auto-lock", bytes.NewBufferString("{bad"))
	rr := httptest.NewRecorder()
	s.handleSetupAutoLockSet(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rr.Code)
	}
}

func TestHandleSetupAutoLockSetInvalidValue(t *testing.T) {
	s := newSetupServer(t)
	initStore(t, s, "correct-horse-battery-staple")
	// 7 is not in the allowlist.
	body := map[string]int{"auto_lock_minutes": 7}
	req := httptest.NewRequest(http.MethodPost, "/api/setup/auto-lock", toJSONBody(t, body))
	rr := httptest.NewRecorder()
	s.handleSetupAutoLockSet(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for invalid auto_lock_minutes", rr.Code)
	}
}

func TestHandleSetupAutoLockSetSuccess(t *testing.T) {
	s := newSetupServer(t)
	initStore(t, s, "correct-horse-battery-staple")
	body := map[string]int{"auto_lock_minutes": 30}
	req := httptest.NewRequest(http.MethodPost, "/api/setup/auto-lock", toJSONBody(t, body))
	rr := httptest.NewRecorder()
	s.handleSetupAutoLockSet(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
}

// ---------------------------------------------------------------------------
// handleSetupNeverConfirmBypassSet
// ---------------------------------------------------------------------------

func TestHandleSetupNeverConfirmBypassMethodGuard(t *testing.T) {
	s := newSetupServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/setup/never-confirm-bypass", nil)
	rr := httptest.NewRecorder()
	s.handleSetupNeverConfirmBypassSet(rr, req)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", rr.Code)
	}
}

func TestHandleSetupNeverConfirmBypassBadJSON(t *testing.T) {
	s := newSetupServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/setup/never-confirm-bypass", bytes.NewBufferString("{bad"))
	rr := httptest.NewRecorder()
	s.handleSetupNeverConfirmBypassSet(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rr.Code)
	}
}

func TestHandleSetupNeverConfirmBypassSuccess(t *testing.T) {
	s := newSetupServer(t)
	initStore(t, s, "correct-horse-battery-staple")
	body := map[string]bool{"never_confirm_startup_bypass": true}
	req := httptest.NewRequest(http.MethodPost, "/api/setup/never-confirm-bypass", toJSONBody(t, body))
	rr := httptest.NewRecorder()
	s.handleSetupNeverConfirmBypassSet(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
}

// ---------------------------------------------------------------------------
// handleProfilesList
// ---------------------------------------------------------------------------

func TestHandleProfilesListMethodGuard(t *testing.T) {
	s := newSetupServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/profiles", nil)
	rr := httptest.NewRecorder()
	s.handleProfilesList(rr, req)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", rr.Code)
	}
}

func TestHandleProfilesListReturnsDefaultProfile(t *testing.T) {
	s := newSetupServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/profiles", nil)
	rr := httptest.NewRecorder()
	s.handleProfilesList(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	var body struct {
		Profiles []struct {
			Name string `json:"name"`
		} `json:"profiles"`
		ActiveProfile string `json:"active_profile"`
	}
	if err := json.NewDecoder(rr.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Profiles) == 0 {
		t.Error("expected at least one profile (default)")
	}
}

// ---------------------------------------------------------------------------
// handleProfilesCreate
// ---------------------------------------------------------------------------

func TestHandleProfilesCreateMethodGuard(t *testing.T) {
	s := newSetupServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/profiles/create", nil)
	rr := httptest.NewRecorder()
	s.handleProfilesCreate(rr, req)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", rr.Code)
	}
}

func TestHandleProfilesCreateBadJSON(t *testing.T) {
	s := newSetupServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/profiles/create", bytes.NewBufferString("{bad"))
	rr := httptest.NewRecorder()
	s.handleProfilesCreate(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rr.Code)
	}
}

func TestHandleProfilesCreateSuccess(t *testing.T) {
	s := newSetupServer(t)
	initStore(t, s, "correct-horse-battery-staple")
	body := map[string]string{"name": "staging"}
	req := httptest.NewRequest(http.MethodPost, "/api/profiles/create", toJSONBody(t, body))
	rr := httptest.NewRecorder()
	s.handleProfilesCreate(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
}

// ---------------------------------------------------------------------------
// handleProfilesSetColor
// ---------------------------------------------------------------------------

func TestHandleProfilesSetColorMethodGuard(t *testing.T) {
	s := newSetupServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/profiles/color", nil)
	rr := httptest.NewRecorder()
	s.handleProfilesSetColor(rr, req)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", rr.Code)
	}
}

func TestHandleProfilesSetColorBadJSON(t *testing.T) {
	s := newSetupServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/profiles/color", bytes.NewBufferString("{bad"))
	rr := httptest.NewRecorder()
	s.handleProfilesSetColor(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rr.Code)
	}
}

func TestHandleProfilesSetColorInvalidColor(t *testing.T) {
	s := newSetupServer(t)
	body := map[string]string{"name": "default", "color": "notacolor"}
	req := httptest.NewRequest(http.MethodPost, "/api/profiles/color", toJSONBody(t, body))
	rr := httptest.NewRecorder()
	s.handleProfilesSetColor(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for invalid color", rr.Code)
	}
}

func TestHandleProfilesSetColorSuccess(t *testing.T) {
	s := newSetupServer(t)
	initStore(t, s, "correct-horse-battery-staple")
	body := map[string]string{"name": "default", "color": "#ff6600"}
	req := httptest.NewRequest(http.MethodPost, "/api/profiles/color", toJSONBody(t, body))
	rr := httptest.NewRecorder()
	s.handleProfilesSetColor(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
}

// ---------------------------------------------------------------------------
// handlePluginSecureStorageGet
// ---------------------------------------------------------------------------

func TestHandlePluginSecureStorageGetMethodGuard(t *testing.T) {
	s := newSetupServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/plugin-storage/get", nil)
	rr := httptest.NewRecorder()
	s.handlePluginSecureStorageGet(rr, req)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", rr.Code)
	}
}

func TestHandlePluginSecureStorageGetBadJSON(t *testing.T) {
	s := newSetupServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/plugin-storage/get", bytes.NewBufferString("{bad"))
	rr := httptest.NewRecorder()
	s.handlePluginSecureStorageGet(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rr.Code)
	}
}

func TestHandlePluginSecureStorageGetInvalidPluginID(t *testing.T) {
	s := newSetupServer(t)
	body := map[string]string{"plugin_id": "bad id!", "key": "validkey"}
	req := httptest.NewRequest(http.MethodPost, "/api/plugin-storage/get", toJSONBody(t, body))
	rr := httptest.NewRecorder()
	s.handlePluginSecureStorageGet(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rr.Code)
	}
}

func TestHandlePluginSecureStorageGetInvalidKey(t *testing.T) {
	s := newSetupServer(t)
	body := map[string]string{"plugin_id": "myplugin", "key": "bad key?"}
	req := httptest.NewRequest(http.MethodPost, "/api/plugin-storage/get", toJSONBody(t, body))
	rr := httptest.NewRecorder()
	s.handlePluginSecureStorageGet(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rr.Code)
	}
}

func TestHandlePluginSecureStorageGetMissingKeyReturnsNull(t *testing.T) {
	s := newSetupServer(t)
	initStore(t, s, "correct-horse-battery-staple")
	body := map[string]string{"plugin_id": "myplugin", "key": "nokey"}
	req := httptest.NewRequest(http.MethodPost, "/api/plugin-storage/get", toJSONBody(t, body))
	rr := httptest.NewRecorder()
	s.handlePluginSecureStorageGet(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rr.Code)
	}
	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	if resp["value"] != nil {
		t.Errorf("value = %v, want nil for missing key", resp["value"])
	}
}

func TestHandlePluginSecureStorageGetFoundValue(t *testing.T) {
	s := newSetupServer(t)
	initStore(t, s, "correct-horse-battery-staple")
	// Pre-populate the store directly.
	if err := s.store.SetSecureValue("myplugin:config", `"hello"`); err != nil {
		t.Fatalf("SetSecureValue: %v", err)
	}
	body := map[string]string{"plugin_id": "myplugin", "key": "config"}
	req := httptest.NewRequest(http.MethodPost, "/api/plugin-storage/get", toJSONBody(t, body))
	rr := httptest.NewRecorder()
	s.handlePluginSecureStorageGet(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rr.Code)
	}
	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	if resp["value"] != "hello" {
		t.Errorf("value = %v, want hello", resp["value"])
	}
}

// ---------------------------------------------------------------------------
// handlePluginSecureStorageSet
// ---------------------------------------------------------------------------

func TestHandlePluginSecureStorageSetMethodGuard(t *testing.T) {
	s := newSetupServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/plugin-storage/set", nil)
	rr := httptest.NewRecorder()
	s.handlePluginSecureStorageSet(rr, req)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", rr.Code)
	}
}

func TestHandlePluginSecureStorageSetBadJSON(t *testing.T) {
	s := newSetupServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/plugin-storage/set", bytes.NewBufferString("{bad"))
	rr := httptest.NewRecorder()
	s.handlePluginSecureStorageSet(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rr.Code)
	}
}

func TestHandlePluginSecureStorageSetInvalidPluginID(t *testing.T) {
	s := newSetupServer(t)
	body := map[string]any{"plugin_id": "bad id", "key": "k", "value": `"v"`}
	req := httptest.NewRequest(http.MethodPost, "/api/plugin-storage/set", toJSONBody(t, body))
	rr := httptest.NewRecorder()
	s.handlePluginSecureStorageSet(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rr.Code)
	}
}

func TestHandlePluginSecureStorageSetMissingValue(t *testing.T) {
	s := newSetupServer(t)
	// Omit the "value" field entirely so RawMessage is nil/empty.
	body := bytes.NewBufferString(`{"plugin_id":"myplugin","key":"k"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/plugin-storage/set", body)
	rr := httptest.NewRecorder()
	s.handlePluginSecureStorageSet(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for missing value", rr.Code)
	}
}

func TestHandlePluginSecureStorageSetSuccess(t *testing.T) {
	s := newSetupServer(t)
	initStore(t, s, "correct-horse-battery-staple")
	body := bytes.NewBufferString(`{"plugin_id":"myplugin","key":"cfg","value":{"token":"abc"}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/plugin-storage/set", body)
	rr := httptest.NewRecorder()
	s.handlePluginSecureStorageSet(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
}

// ---------------------------------------------------------------------------
// handlePluginSecureStorageDelete
// ---------------------------------------------------------------------------

func TestHandlePluginSecureStorageDeleteMethodGuard(t *testing.T) {
	s := newSetupServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/plugin-storage/delete", nil)
	rr := httptest.NewRecorder()
	s.handlePluginSecureStorageDelete(rr, req)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", rr.Code)
	}
}

func TestHandlePluginSecureStorageDeleteBadJSON(t *testing.T) {
	s := newSetupServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/plugin-storage/delete", bytes.NewBufferString("{bad"))
	rr := httptest.NewRecorder()
	s.handlePluginSecureStorageDelete(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rr.Code)
	}
}

func TestHandlePluginSecureStorageDeleteInvalidPluginID(t *testing.T) {
	s := newSetupServer(t)
	body := map[string]string{"plugin_id": "bad id!", "key": "k"}
	req := httptest.NewRequest(http.MethodPost, "/api/plugin-storage/delete", toJSONBody(t, body))
	rr := httptest.NewRecorder()
	s.handlePluginSecureStorageDelete(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rr.Code)
	}
}

func TestHandlePluginSecureStorageDeleteSuccess(t *testing.T) {
	s := newSetupServer(t)
	initStore(t, s, "correct-horse-battery-staple")
	// Set a key then delete it.
	if err := s.store.SetSecureValue("myplugin:todel", `"v"`); err != nil {
		t.Fatalf("SetSecureValue: %v", err)
	}
	body := map[string]string{"plugin_id": "myplugin", "key": "todel"}
	req := httptest.NewRequest(http.MethodPost, "/api/plugin-storage/delete", toJSONBody(t, body))
	rr := httptest.NewRecorder()
	s.handlePluginSecureStorageDelete(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("status = %d, want 200; body: %s", rr.Code, rr.Body.String())
	}
}

// ---------------------------------------------------------------------------
// handleContextsImport validation paths (no live cluster needed)
// ---------------------------------------------------------------------------

func TestHandleContextsImportMethodGuard(t *testing.T) {
	s := newSetupServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/contexts/import", nil)
	rr := httptest.NewRecorder()
	s.handleContextsImport(rr, req)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", rr.Code)
	}
}

func TestHandleContextsImportBadJSON(t *testing.T) {
	s := newSetupServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/contexts/import", bytes.NewBufferString("{bad"))
	rr := httptest.NewRecorder()
	s.handleContextsImport(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rr.Code)
	}
}

func TestHandleContextsImportMissingName(t *testing.T) {
	s := newSetupServer(t)
	body := map[string]string{"kubeconfig": "some-yaml"}
	req := httptest.NewRequest(http.MethodPost, "/api/contexts/import", toJSONBody(t, body))
	rr := httptest.NewRecorder()
	s.handleContextsImport(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for missing name", rr.Code)
	}
}

func TestHandleContextsImportMissingKubeconfig(t *testing.T) {
	s := newSetupServer(t)
	body := map[string]string{"name": "my-ctx"}
	req := httptest.NewRequest(http.MethodPost, "/api/contexts/import", toJSONBody(t, body))
	rr := httptest.NewRecorder()
	s.handleContextsImport(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for missing kubeconfig", rr.Code)
	}
}

// ---------------------------------------------------------------------------
// handleContextsDelete validation paths
// ---------------------------------------------------------------------------

func TestHandleContextsDeleteMethodGuard(t *testing.T) {
	s := newSetupServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/contexts/delete", nil)
	rr := httptest.NewRecorder()
	s.handleContextsDelete(rr, req)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", rr.Code)
	}
}

func TestHandleContextsDeleteMissingName(t *testing.T) {
	s := newSetupServer(t)
	body := map[string]string{}
	req := httptest.NewRequest(http.MethodPost, "/api/contexts/delete", toJSONBody(t, body))
	rr := httptest.NewRecorder()
	s.handleContextsDelete(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for missing name", rr.Code)
	}
}

// ---------------------------------------------------------------------------
// extractExecAuth (pure function)
// ---------------------------------------------------------------------------

func TestExtractExecAuthNoExecSection(t *testing.T) {
	kubeconfig := `
apiVersion: v1
kind: Config
current-context: test-ctx
contexts:
- name: test-ctx
  context:
    cluster: test-cluster
    user: test-user
clusters:
- name: test-cluster
  cluster:
    server: https://localhost:6443
users:
- name: test-user
  user:
    token: abc123
`
	cmd, args, err := extractExecAuth(kubeconfig)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cmd != "" || len(args) != 0 {
		t.Errorf("expected empty command/args for token auth, got cmd=%q args=%v", cmd, args)
	}
}

func TestExtractExecAuthWithExecPlugin(t *testing.T) {
	kubeconfig := `
apiVersion: v1
kind: Config
current-context: exec-ctx
contexts:
- name: exec-ctx
  context:
    cluster: exec-cluster
    user: exec-user
clusters:
- name: exec-cluster
  cluster:
    server: https://localhost:6443
users:
- name: exec-user
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      args:
      - eks
      - get-token
`
	cmd, args, err := extractExecAuth(kubeconfig)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cmd != "aws" {
		t.Errorf("command = %q, want aws", cmd)
	}
	if len(args) != 2 || args[0] != "eks" || args[1] != "get-token" {
		t.Errorf("args = %v, want [eks get-token]", args)
	}
}

func TestExtractExecAuthInvalidYAML(t *testing.T) {
	_, _, err := extractExecAuth("not: valid: yaml: {{{{")
	if err == nil {
		t.Error("expected error for invalid YAML")
	}
}

func TestExtractExecAuthNoCurrentContext(t *testing.T) {
	kubeconfig := `
apiVersion: v1
kind: Config
clusters: []
users: []
contexts: []
`
	cmd, args, err := extractExecAuth(kubeconfig)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cmd != "" || len(args) != 0 {
		t.Errorf("expected empty for no current-context, got cmd=%q", cmd)
	}
}
