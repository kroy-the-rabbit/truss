package contextstore

import (
	"path/filepath"
	"testing"
)

// newTestStore returns an uninitialized store pointing to a temp directory.
// Access to unexported fields is allowed because this file is in the same package.
func newTestStore(t *testing.T) *Store {
	t.Helper()
	tmp := t.TempDir()
	s := &Store{
		path: filepath.Join(tmp, storeFileName),
		profiles: map[string]profileData{
			defaultProfileName: {Contexts: make(map[string]ContextEntry)},
		},
		activeProfile: defaultProfileName,
	}
	return s
}

// TestSanitizeProfileColor checks the hex color validation.
func TestSanitizeProfileColor(t *testing.T) {
	tests := []struct {
		input   string
		want    string
		wantErr bool
	}{
		{"", "", false},
		{"   ", "", false},
		{"#aabbcc", "#aabbcc", false},
		{"#AABBCC", "#aabbcc", false},  // normalised to lowercase
		{"#ABC", "", true},              // too short
		{"#AABBCCD", "", true},          // too long
		{"aabbcc", "", true},            // missing #
		{"#zzzzzz", "", true},           // non-hex chars
	}
	for _, tt := range tests {
		got, err := sanitizeProfileColor(tt.input)
		if tt.wantErr {
			if err == nil {
				t.Errorf("sanitizeProfileColor(%q): expected error, got nil", tt.input)
			}
			continue
		}
		if err != nil {
			t.Errorf("sanitizeProfileColor(%q): unexpected error: %v", tt.input, err)
			continue
		}
		if got != tt.want {
			t.Errorf("sanitizeProfileColor(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

// TestAutoLockMinutesDefault verifies the default when nothing is set.
func TestAutoLockMinutesDefault(t *testing.T) {
	s := newTestStore(t)
	if got := s.AutoLockMinutes(); got != defaultAutoLockMinutes {
		t.Errorf("AutoLockMinutes() = %d, want %d (default)", got, defaultAutoLockMinutes)
	}
}

// TestSetAutoLockMinutesAllowlist verifies allowed and rejected values.
func TestSetAutoLockMinutesAllowlist(t *testing.T) {
	s := newTestStore(t)
	if err := s.Initialize("password", "", "testpassword"); err != nil {
		t.Fatalf("Initialize: %v", err)
	}

	allowed := []int{0, 5, 10, 20, 30, 60, 120}
	for _, v := range allowed {
		if err := s.SetAutoLockMinutes(v); err != nil {
			t.Errorf("SetAutoLockMinutes(%d) unexpected error: %v", v, err)
			continue
		}
		if got := s.AutoLockMinutes(); got != v {
			t.Errorf("AutoLockMinutes() = %d after Set(%d)", got, v)
		}
	}

	disallowed := []int{-1, 1, 15, 45, 90, 121, 999}
	for _, v := range disallowed {
		if err := s.SetAutoLockMinutes(v); err == nil {
			t.Errorf("SetAutoLockMinutes(%d) expected error, got nil", v)
		}
	}
}

// TestSecureValueRoundTrip verifies set → get → delete.
func TestSecureValueRoundTrip(t *testing.T) {
	s := newTestStore(t)
	if err := s.Initialize("password", "", "testpassword"); err != nil {
		t.Fatalf("Initialize: %v", err)
	}

	const key = "test-key"
	const val = "secret-value"

	// Not present initially.
	if _, ok := s.GetSecureValue(key); ok {
		t.Fatal("expected key to be absent before Set")
	}

	// Set and retrieve.
	if err := s.SetSecureValue(key, val); err != nil {
		t.Fatalf("SetSecureValue: %v", err)
	}
	got, ok := s.GetSecureValue(key)
	if !ok {
		t.Fatal("GetSecureValue: key not found after Set")
	}
	if got != val {
		t.Errorf("GetSecureValue = %q, want %q", got, val)
	}

	// Overwrite.
	if err := s.SetSecureValue(key, "new-val"); err != nil {
		t.Fatalf("SetSecureValue (overwrite): %v", err)
	}
	if got, _ := s.GetSecureValue(key); got != "new-val" {
		t.Errorf("after overwrite, GetSecureValue = %q, want %q", got, "new-val")
	}

	// Delete.
	if err := s.DeleteSecureValue(key); err != nil {
		t.Fatalf("DeleteSecureValue: %v", err)
	}
	if _, ok := s.GetSecureValue(key); ok {
		t.Fatal("expected key to be absent after Delete")
	}
}

// TestSecureValueRequiresInitialized verifies that mutating the store before
// Initialize returns an error.
func TestSecureValueRequiresInitialized(t *testing.T) {
	s := newTestStore(t) // not yet initialized

	if err := s.SetSecureValue("k", "v"); err == nil {
		t.Error("SetSecureValue on uninitialized store should return error")
	}
	if err := s.DeleteSecureValue("k"); err == nil {
		t.Error("DeleteSecureValue on uninitialized store should return error")
	}
}

// TestInitializePasswordTooShort verifies the minimum password length.
func TestInitializePasswordTooShort(t *testing.T) {
	s := newTestStore(t)
	if err := s.Initialize("password", "", "short"); err == nil {
		t.Error("Initialize with 5-char password should fail")
	}
	if s.IsInitialized() {
		t.Error("store should not be initialized after failed Initialize")
	}
}

// TestInitializeInvalidMethod verifies that an unknown method is rejected.
func TestInitializeInvalidMethod(t *testing.T) {
	s := newTestStore(t)
	if err := s.Initialize("plaintext", "", ""); err == nil {
		t.Error("Initialize with unknown method should fail")
	}
}

// TestInitializeAlreadyInitialized verifies idempotency protection.
func TestInitializeAlreadyInitialized(t *testing.T) {
	s := newTestStore(t)
	if err := s.Initialize("password", "", "testpassword"); err != nil {
		t.Fatalf("first Initialize: %v", err)
	}
	if err := s.Initialize("password", "", "testpassword"); err == nil {
		t.Error("second Initialize on already-initialized store should fail")
	}
}

// TestPasswordLockUnlockCycle verifies the full lock → unlock round-trip.
// The secure value set before locking must be recoverable after unlock.
func TestPasswordLockUnlockCycle(t *testing.T) {
	s := newTestStore(t)
	if err := s.Initialize("password", "", "testpassword"); err != nil {
		t.Fatalf("Initialize: %v", err)
	}

	// Store a value that must survive lock/unlock.
	if err := s.SetSecureValue("persist-key", "persist-val"); err != nil {
		t.Fatalf("SetSecureValue: %v", err)
	}

	// Lock.
	if err := s.Lock(); err != nil {
		t.Fatalf("Lock: %v", err)
	}
	if !s.IsLocked() {
		t.Fatal("expected store to be locked")
	}

	// GetSecureValue should be empty while locked (not crash).
	if _, ok := s.GetSecureValue("persist-key"); ok {
		t.Error("GetSecureValue should return nothing while locked")
	}

	// Unlock with wrong password.
	if err := s.Unlock("wrongpass"); err == nil {
		t.Error("Unlock with wrong password should fail")
	}
	if !s.IsLocked() {
		t.Error("store should remain locked after wrong password")
	}

	// Unlock with correct password.
	if err := s.Unlock("testpassword"); err != nil {
		t.Fatalf("Unlock: %v", err)
	}
	if s.IsLocked() {
		t.Fatal("expected store to be unlocked")
	}

	// Persisted value must be available again.
	got, ok := s.GetSecureValue("persist-key")
	if !ok {
		t.Fatal("secure value not found after unlock")
	}
	if got != "persist-val" {
		t.Errorf("GetSecureValue after unlock = %q, want %q", got, "persist-val")
	}
}

// TestProfileCRUD covers create, rename, delete, and the last-profile guard.
func TestProfileCRUD(t *testing.T) {
	s := newTestStore(t)
	if err := s.Initialize("password", "", "testpassword"); err != nil {
		t.Fatalf("Initialize: %v", err)
	}

	// CreateProfile.
	if err := s.CreateProfile("work"); err != nil {
		t.Fatalf("CreateProfile: %v", err)
	}
	names := s.ProfileNames()
	if len(names) != 2 {
		t.Fatalf("expected 2 profiles (default+work), got %d: %v", len(names), names)
	}

	// Duplicate create fails.
	if err := s.CreateProfile("work"); err == nil {
		t.Error("duplicate CreateProfile should fail")
	}

	// SetActiveProfile.
	if err := s.SetActiveProfile("work"); err != nil {
		t.Fatalf("SetActiveProfile: %v", err)
	}
	if s.ActiveProfile() != "work" {
		t.Errorf("ActiveProfile = %q, want work", s.ActiveProfile())
	}

	// RenameProfile.
	if err := s.RenameProfile("work", "office"); err != nil {
		t.Fatalf("RenameProfile: %v", err)
	}
	if s.ActiveProfile() != "office" {
		t.Errorf("after rename, ActiveProfile = %q, want office", s.ActiveProfile())
	}

	// DeleteProfile — switch back to default first.
	if err := s.SetActiveProfile(defaultProfileName); err != nil {
		t.Fatalf("SetActiveProfile(default): %v", err)
	}
	if err := s.DeleteProfile("office"); err != nil {
		t.Fatalf("DeleteProfile: %v", err)
	}
	if len(s.ProfileNames()) != 1 {
		t.Errorf("expected 1 profile after delete, got %d", len(s.ProfileNames()))
	}

	// Cannot delete the last profile.
	if err := s.DeleteProfile(defaultProfileName); err == nil {
		t.Error("deleting the last profile should fail")
	}
}

// TestProfileColorValidation verifies SetProfileColor rejects bad hex values.
func TestProfileColorValidation(t *testing.T) {
	s := newTestStore(t)
	if err := s.Initialize("password", "", "testpassword"); err != nil {
		t.Fatalf("Initialize: %v", err)
	}

	if err := s.SetProfileColor(defaultProfileName, "#ff0000"); err != nil {
		t.Fatalf("SetProfileColor(valid): %v", err)
	}
	if got := s.ProfileColor(defaultProfileName); got != "#ff0000" {
		t.Errorf("ProfileColor = %q, want #ff0000", got)
	}

	if err := s.SetProfileColor(defaultProfileName, "not-a-color"); err == nil {
		t.Error("SetProfileColor(invalid) should fail")
	}

	// Valid: empty string clears the color.
	if err := s.SetProfileColor(defaultProfileName, ""); err != nil {
		t.Fatalf("SetProfileColor(empty): %v", err)
	}
	if got := s.ProfileColor(defaultProfileName); got != "" {
		t.Errorf("expected empty color after clear, got %q", got)
	}
}
