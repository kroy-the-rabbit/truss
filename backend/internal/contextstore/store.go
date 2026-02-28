package contextstore

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"

	"golang.org/x/crypto/argon2"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

const (
	storeFileName            = "contexts.enc"
	defaultDirName           = "truss"
	encryptionMethodGPG      = "gpg"
	encryptionMethodPassword = "password"
	defaultProfileName       = "default"
	storePayloadVersion      = 2
	profileSchemaVersion     = 1
	contextSchemaVersion     = 1
	defaultAutoLockMinutes   = 20
	autoLockSecureKey        = "__truss:auto_lock_minutes"
	neverConfirmBypassKey    = "__truss:never_confirm_startup_bypass"

	argon2Time    = 3
	argon2Memory  = 64 * 1024
	argon2Threads = 4
	argon2KeyLen  = 32
)

var allowedAutoLockMinutes = map[int]struct{}{
	0:   {},
	5:   {},
	10:  {},
	20:  {},
	30:  {},
	60:  {},
	120: {},
}

// ContextEntry holds a fully self-contained kubeconfig for one context.
type ContextEntry struct {
	Version     int    `json:"version,omitempty"`
	Name        string `json:"name"`
	DisplayName string `json:"display_name,omitempty"`
	Kubeconfig  string `json:"kubeconfig"` // full kubeconfig YAML, current-context set
}

type profileData struct {
	Version       int                     `json:"version,omitempty"`
	Color         string                  `json:"color,omitempty"`
	Secure        map[string]string       `json:"secure,omitempty"`
	Contexts      map[string]ContextEntry `json:"contexts"`
	ActiveContext string                  `json:"active_context,omitempty"`
}

// innerData is the plaintext payload stored inside the encrypted envelope.
type innerData struct {
	Profiles      map[string]profileData  `json:"profiles,omitempty"`
	ActiveProfile string                  `json:"active_profile,omitempty"`
	Contexts      map[string]ContextEntry `json:"contexts,omitempty"`       // v1 legacy
	ActiveContext string                  `json:"active_context,omitempty"` // v1 legacy
}

// encryptedEnvelope is the on-disk JSON wrapper.
type encryptedEnvelope struct {
	Version    int    `json:"version"`
	Method     string `json:"method"`
	GpgKey     string `json:"gpg_key,omitempty"`
	Payload    string `json:"payload,omitempty"`    // GPG
	Salt       string `json:"salt,omitempty"`       // password
	Nonce      string `json:"nonce,omitempty"`      // password
	Ciphertext string `json:"ciphertext,omitempty"` // password
}

// GPGKeyInfo describes an available GPG secret key.
type GPGKeyInfo struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
}

// KubeconfigContextInfo describes a context entry in the system kubeconfig.
type KubeconfigContextInfo struct {
	Name    string `json:"name"`
	Cluster string `json:"cluster"`
	User    string `json:"user"`
}

// Store manages the encrypted context vault.
type Store struct {
	mu            sync.RWMutex
	path          string
	initialized   bool   // false: no file on disk yet
	locked        bool   // true: file exists but not yet decrypted
	broken        bool   // true: file exists but is corrupted / unreadable
	brokenErr     string // human-readable reason for broken state
	method        string
	gpgKey        string
	password      string // in-memory only
	profiles      map[string]profileData
	activeProfile string
	rawEnv        *encryptedEnvelope // kept while locked for Unlock()
}

// New loads (or starts empty) the encrypted context store.
func New() (*Store, error) {
	path, err := resolveStorePath()
	if err != nil {
		return nil, err
	}
	s := &Store{path: path}

	b, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			// First run — uninitialized, unlocked, empty.
			s.profiles = map[string]profileData{
				defaultProfileName: {Contexts: make(map[string]ContextEntry)},
			}
			s.activeProfile = defaultProfileName
			return s, nil
		}
		s.broken = true
		s.brokenErr = fmt.Sprintf("reading context store: %v", err)
		s.profiles = map[string]profileData{
			defaultProfileName: {Contexts: make(map[string]ContextEntry)},
		}
		s.activeProfile = defaultProfileName
		return s, nil
	}

	var env encryptedEnvelope
	if err := json.Unmarshal(b, &env); err != nil {
		s.broken = true
		s.brokenErr = fmt.Sprintf("context store file is corrupted (invalid JSON): %v", err)
		s.profiles = map[string]profileData{
			defaultProfileName: {Contexts: make(map[string]ContextEntry)},
		}
		s.activeProfile = defaultProfileName
		return s, nil
	}
	s.initialized = true
	s.method = env.Method
	s.gpgKey = env.GpgKey
	s.rawEnv = &env

	switch env.Method {
	case encryptionMethodGPG:
		plain, err := gpgDecrypt(env.Payload)
		if err != nil {
			// GPG unavailable or key missing — start locked.
			s.locked = true
			return s, nil
		}
		if err := s.loadInner(plain); err != nil {
			s.broken = true
			s.brokenErr = fmt.Sprintf("decrypted payload is corrupted: %v", err)
			s.locked = false
			s.initialized = false
			s.profiles = map[string]profileData{
				defaultProfileName: {Contexts: make(map[string]ContextEntry)},
			}
			s.activeProfile = defaultProfileName
			return s, nil
		}
	case encryptionMethodPassword:
		// Start locked; caller must call Unlock(password).
		s.locked = true
	default:
		s.broken = true
		s.brokenErr = fmt.Sprintf("unsupported encryption method %q — store may be from a newer version", env.Method)
		s.profiles = map[string]profileData{
			defaultProfileName: {Contexts: make(map[string]ContextEntry)},
		}
		s.activeProfile = defaultProfileName
		return s, nil
	}
	return s, nil
}

// IsInitialized reports whether the store has been set up.
func (s *Store) IsInitialized() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.initialized
}

// IsLocked reports whether the store is encrypted and needs a password or GPG.
func (s *Store) IsLocked() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.locked
}

// IsBroken reports whether the store file exists but cannot be read or decrypted.
// The app should offer a reset option rather than being permanently stuck.
func (s *Store) IsBroken() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.broken
}

// BrokenError returns a human-readable description of why the store is broken.
func (s *Store) BrokenError() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.brokenErr
}

// Reset deletes the on-disk store and returns the in-memory state to uninitialized.
// Use this as a recovery path when the store is corrupted or inaccessible.
func (s *Store) Reset() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.Remove(s.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("removing store file: %w", err)
	}
	s.initialized = false
	s.locked = false
	s.broken = false
	s.brokenErr = ""
	s.method = ""
	s.gpgKey = ""
	s.password = ""
	s.profiles = map[string]profileData{
		defaultProfileName: {Contexts: make(map[string]ContextEntry)},
	}
	s.activeProfile = defaultProfileName
	s.rawEnv = nil
	return nil
}

// Method returns the encryption method ("gpg" or "password"), or "" if uninitialized.
func (s *Store) Method() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.method
}

// GPGKey returns the GPG recipient key ID used, if any.
func (s *Store) GPGKey() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.gpgKey
}

// LastActiveContext returns the stored active context name, if set.
func (s *Store) LastActiveContext() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	profile := s.profiles[s.activeProfile]
	return profile.ActiveContext
}

// SetActiveContext stores the active context name in the encrypted store.
func (s *Store) SetActiveContext(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.initialized || s.locked {
		return errors.New("store is not ready")
	}
	profile := s.ensureActiveProfileLocked()
	if name != "" {
		if _, ok := profile.Contexts[name]; !ok {
			return fmt.Errorf("context %q not found", name)
		}
	}
	profile.ActiveContext = name
	s.profiles[s.activeProfile] = profile
	return s.saveLocked()
}

func sanitizeProfileName(name string) string {
	return strings.TrimSpace(name)
}

var hexColorRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func sanitizeProfileColor(color string) (string, error) {
	c := strings.TrimSpace(color)
	if c == "" {
		return "", nil
	}
	if !hexColorRe.MatchString(c) {
		return "", errors.New("profile color must be empty or #RRGGBB")
	}
	return strings.ToLower(c), nil
}

// ActiveProfile returns the selected profile.
func (s *Store) ActiveProfile() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.activeProfile == "" {
		return defaultProfileName
	}
	return s.activeProfile
}

// ProfileNames returns all profile names in sorted order.
func (s *Store) ProfileNames() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	names := make([]string, 0, len(s.profiles))
	for name := range s.profiles {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// ProfileColor returns a profile color or empty.
func (s *Store) ProfileColor(name string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	profile, ok := s.profiles[name]
	if !ok {
		return ""
	}
	return profile.Color
}

// ActiveProfileColor returns active profile color or empty.
func (s *Store) ActiveProfileColor() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	profile, ok := s.profiles[s.activeProfile]
	if !ok {
		return ""
	}
	return profile.Color
}

// SetActiveProfile switches the selected profile.
func (s *Store) SetActiveProfile(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.initialized || s.locked {
		return errors.New("store is not ready")
	}
	name = sanitizeProfileName(name)
	if name == "" {
		return errors.New("profile name is required")
	}
	if _, ok := s.profiles[name]; !ok {
		return fmt.Errorf("profile %q not found", name)
	}
	s.activeProfile = name
	return s.saveLocked()
}

// CreateProfile adds a new empty profile.
func (s *Store) CreateProfile(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.initialized || s.locked {
		return errors.New("store is not ready")
	}
	name = sanitizeProfileName(name)
	if name == "" {
		return errors.New("profile name is required")
	}
	if _, ok := s.profiles[name]; ok {
		return fmt.Errorf("profile %q already exists", name)
	}
	s.profiles[name] = profileData{Version: profileSchemaVersion, Contexts: make(map[string]ContextEntry)}
	return s.saveLocked()
}

// SetProfileColor updates a profile display color.
func (s *Store) SetProfileColor(name, color string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.initialized || s.locked {
		return errors.New("store is not ready")
	}
	name = sanitizeProfileName(name)
	if name == "" {
		return errors.New("profile name is required")
	}
	profile, ok := s.profiles[name]
	if !ok {
		return fmt.Errorf("profile %q not found", name)
	}
	sanitized, err := sanitizeProfileColor(color)
	if err != nil {
		return err
	}
	profile.Color = sanitized
	s.profiles[name] = profile
	return s.saveLocked()
}

// GetSecureValue returns an encrypted key/value from the active profile.
func (s *Store) GetSecureValue(key string) (string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	profile, ok := s.profiles[s.activeProfile]
	if !ok || profile.Secure == nil {
		return "", false
	}
	v, ok := profile.Secure[key]
	return v, ok
}

// SetSecureValue stores an encrypted key/value in the active profile.
func (s *Store) SetSecureValue(key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.initialized || s.locked {
		return errors.New("store is not ready")
	}
	profile := s.ensureActiveProfileLocked()
	if profile.Secure == nil {
		profile.Secure = make(map[string]string)
	}
	profile.Secure[key] = value
	s.profiles[s.activeProfile] = profile
	return s.saveLocked()
}

// DeleteSecureValue removes an encrypted key from the active profile.
func (s *Store) DeleteSecureValue(key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.initialized || s.locked {
		return errors.New("store is not ready")
	}
	profile := s.ensureActiveProfileLocked()
	if profile.Secure != nil {
		delete(profile.Secure, key)
	}
	s.profiles[s.activeProfile] = profile
	return s.saveLocked()
}

// AutoLockMinutes returns the configured auto-lock timeout for the active profile.
// Returns the default when not set or invalid.
func (s *Store) AutoLockMinutes() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	profile, ok := s.profiles[s.activeProfile]
	if !ok || profile.Secure == nil {
		return defaultAutoLockMinutes
	}
	raw, ok := profile.Secure[autoLockSecureKey]
	if !ok || raw == "" {
		return defaultAutoLockMinutes
	}
	var minutes int
	if err := json.Unmarshal([]byte(raw), &minutes); err != nil {
		return defaultAutoLockMinutes
	}
	if _, ok := allowedAutoLockMinutes[minutes]; !ok {
		return defaultAutoLockMinutes
	}
	return minutes
}

// SetAutoLockMinutes stores the auto-lock timeout for the active profile.
// Accepts only strict allowlist values.
func (s *Store) SetAutoLockMinutes(minutes int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.initialized || s.locked {
		return errors.New("store is not ready")
	}
	if _, ok := allowedAutoLockMinutes[minutes]; !ok {
		return errors.New("invalid auto-lock minutes")
	}
	profile := s.ensureActiveProfileLocked()
	if profile.Secure == nil {
		profile.Secure = make(map[string]string)
	}
	b, err := json.Marshal(minutes)
	if err != nil {
		return fmt.Errorf("encoding auto-lock minutes: %w", err)
	}
	profile.Secure[autoLockSecureKey] = string(b)
	s.profiles[s.activeProfile] = profile
	return s.saveLocked()
}

// NeverConfirmStartupBypass reports whether startup confirmation is bypassed
// when auto-lock is set to "never".
func (s *Store) NeverConfirmStartupBypass() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	profile, ok := s.profiles[s.activeProfile]
	if !ok || profile.Secure == nil {
		return false
	}
	raw, ok := profile.Secure[neverConfirmBypassKey]
	if !ok || raw == "" {
		return false
	}
	var bypass bool
	if err := json.Unmarshal([]byte(raw), &bypass); err != nil {
		return false
	}
	return bypass
}

// SetNeverConfirmStartupBypass stores whether startup confirmation is bypassed
// when auto-lock is set to "never".
func (s *Store) SetNeverConfirmStartupBypass(bypass bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.initialized || s.locked {
		return errors.New("store is not ready")
	}
	profile := s.ensureActiveProfileLocked()
	if profile.Secure == nil {
		profile.Secure = make(map[string]string)
	}
	b, err := json.Marshal(bypass)
	if err != nil {
		return fmt.Errorf("encoding startup bypass preference: %w", err)
	}
	profile.Secure[neverConfirmBypassKey] = string(b)
	s.profiles[s.activeProfile] = profile
	return s.saveLocked()
}

// RenameProfile renames an existing profile.
func (s *Store) RenameProfile(oldName, newName string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.initialized || s.locked {
		return errors.New("store is not ready")
	}
	oldName = sanitizeProfileName(oldName)
	newName = sanitizeProfileName(newName)
	if oldName == "" || newName == "" {
		return errors.New("profile names are required")
	}
	if oldName == newName {
		return nil
	}
	profile, ok := s.profiles[oldName]
	if !ok {
		return fmt.Errorf("profile %q not found", oldName)
	}
	if _, exists := s.profiles[newName]; exists {
		return fmt.Errorf("profile %q already exists", newName)
	}
	delete(s.profiles, oldName)
	s.profiles[newName] = profile
	if s.activeProfile == oldName {
		s.activeProfile = newName
	}
	return s.saveLocked()
}

// DeleteProfile removes a profile and falls back to another one.
func (s *Store) DeleteProfile(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.initialized || s.locked {
		return errors.New("store is not ready")
	}
	name = sanitizeProfileName(name)
	if name == "" {
		return errors.New("profile name is required")
	}
	if _, ok := s.profiles[name]; !ok {
		return fmt.Errorf("profile %q not found", name)
	}
	if len(s.profiles) == 1 {
		return errors.New("cannot delete the last profile")
	}
	delete(s.profiles, name)
	if s.activeProfile == name {
		if _, ok := s.profiles[defaultProfileName]; ok {
			s.activeProfile = defaultProfileName
		} else {
			names := make([]string, 0, len(s.profiles))
			for profileName := range s.profiles {
				names = append(names, profileName)
			}
			sort.Strings(names)
			s.activeProfile = names[0]
		}
	}
	return s.saveLocked()
}

// Unlock decrypts the store using the provided password. Only valid when method=password.
func (s *Store) Unlock(password string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.locked || s.rawEnv == nil {
		return errors.New("store is not locked")
	}
	plain, err := passwordDecrypt(*s.rawEnv, password)
	if err != nil {
		return fmt.Errorf("wrong password or corrupted store: %w", err)
	}
	if err := s.loadInner(plain); err != nil {
		return err
	}
	s.password = password
	s.locked = false
	return nil
}

// Lock clears decrypted in-memory state and requires Unlock() before use again.
// This is only supported for password-encrypted stores.
func (s *Store) Lock() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.initialized {
		return errors.New("store is not initialized")
	}
	if s.locked {
		return nil
	}
	if s.method != encryptionMethodPassword {
		return errors.New("lock is only supported for password-encrypted stores")
	}
	if s.rawEnv == nil {
		return errors.New("store envelope unavailable")
	}

	// Drop all decrypted material from memory.
	s.profiles = nil
	s.activeProfile = ""
	s.password = ""
	s.locked = true
	return nil
}

// Initialize creates a new encrypted store with the chosen method.
// Must only be called when the store is uninitialized.
func (s *Store) Initialize(method, gpgKey, password string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.initialized {
		return errors.New("store is already initialized")
	}
	if method != encryptionMethodGPG && method != encryptionMethodPassword {
		return fmt.Errorf("unsupported method %q", method)
	}
	if method == encryptionMethodPassword && len(password) < 8 {
		return errors.New("password must be at least 8 characters")
	}
	s.method = method
	s.gpgKey = gpgKey
	s.password = password
	s.profiles = map[string]profileData{
		defaultProfileName: {Version: profileSchemaVersion, Contexts: make(map[string]ContextEntry)},
	}
	s.activeProfile = defaultProfileName
	s.initialized = true
	s.locked = false
	return s.saveLocked()
}

// ContextNames returns all stored context names, sorted.
func (s *Store) ContextNames() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	profile := s.profiles[s.activeProfile]
	names := make([]string, 0, len(profile.Contexts))
	for name := range profile.Contexts {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// GetContextEntry returns the ContextEntry for the given name.
func (s *Store) GetContextEntry(name string) (ContextEntry, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	profile := s.profiles[s.activeProfile]
	e, ok := profile.Contexts[name]
	return e, ok
}

// ImportContext stores a context with the given name (key), display name, and
// full self-contained kubeconfig YAML. If an entry with that name already
// exists it is overwritten.
func (s *Store) ImportContext(name, displayName, kubeconfigYAML string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.initialized || s.locked {
		return errors.New("store is not ready")
	}
	profile := s.ensureActiveProfileLocked()
	if profile.Contexts == nil {
		profile.Contexts = make(map[string]ContextEntry)
	}
	profile.Contexts[name] = ContextEntry{
		Version:     contextSchemaVersion,
		Name:        name,
		DisplayName: displayName,
		Kubeconfig:  kubeconfigYAML,
	}
	s.profiles[s.activeProfile] = profile
	return s.saveLocked()
}

// RemoveContext deletes the named context from the store.
func (s *Store) RemoveContext(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.initialized || s.locked {
		return errors.New("store is not ready")
	}
	profile := s.ensureActiveProfileLocked()
	delete(profile.Contexts, name)
	if profile.ActiveContext == name {
		profile.ActiveContext = ""
		if len(profile.Contexts) > 0 {
			names := make([]string, 0, len(profile.Contexts))
			for ctxName := range profile.Contexts {
				names = append(names, ctxName)
			}
			sort.Strings(names)
			profile.ActiveContext = names[0]
		}
	}
	s.profiles[s.activeProfile] = profile
	return s.saveLocked()
}

// --- helpers ---

func (s *Store) loadInner(plain []byte) error {
	var inner innerData
	if err := json.Unmarshal(plain, &inner); err != nil {
		return fmt.Errorf("parsing context store payload: %w", err)
	}

	if len(inner.Profiles) == 0 {
		legacyContexts := inner.Contexts
		if legacyContexts == nil {
			legacyContexts = make(map[string]ContextEntry)
		}
		inner.Profiles = map[string]profileData{
			defaultProfileName: {
				Version:       profileSchemaVersion,
				Contexts:      legacyContexts,
				ActiveContext: inner.ActiveContext,
			},
		}
		inner.ActiveProfile = defaultProfileName
	}

	for name, profile := range inner.Profiles {
		if profile.Version == 0 {
			profile.Version = profileSchemaVersion
		}
		if profile.Contexts == nil {
			profile.Contexts = make(map[string]ContextEntry)
		}
		if profile.Secure == nil {
			profile.Secure = make(map[string]string)
		}
		for ctxName, entry := range profile.Contexts {
			if entry.Version == 0 {
				entry.Version = contextSchemaVersion
			}
			profile.Contexts[ctxName] = entry
		}
		if profile.ActiveContext != "" {
			if _, ok := profile.Contexts[profile.ActiveContext]; !ok {
				profile.ActiveContext = ""
			}
		}
		inner.Profiles[name] = profile
	}

	s.profiles = inner.Profiles
	s.activeProfile = sanitizeProfileName(inner.ActiveProfile)
	if s.activeProfile == "" {
		s.activeProfile = defaultProfileName
	}
	if _, ok := s.profiles[s.activeProfile]; !ok {
		s.profiles[s.activeProfile] = profileData{Version: profileSchemaVersion, Contexts: make(map[string]ContextEntry)}
	}
	return nil
}

func (s *Store) ensureActiveProfileLocked() profileData {
	if s.profiles == nil {
		s.profiles = make(map[string]profileData)
	}
	if s.activeProfile == "" {
		s.activeProfile = defaultProfileName
	}
	profile, ok := s.profiles[s.activeProfile]
	if !ok {
		profile = profileData{Version: profileSchemaVersion, Contexts: make(map[string]ContextEntry)}
	}
	if profile.Version == 0 {
		profile.Version = profileSchemaVersion
	}
	if profile.Contexts == nil {
		profile.Contexts = make(map[string]ContextEntry)
	}
	if profile.Secure == nil {
		profile.Secure = make(map[string]string)
	}
	for name, entry := range profile.Contexts {
		if entry.Version == 0 {
			entry.Version = contextSchemaVersion
			profile.Contexts[name] = entry
		}
	}
	s.profiles[s.activeProfile] = profile
	return profile
}

// saveLocked writes the store to disk. Caller must hold s.mu.Lock().
func (s *Store) saveLocked() error {
	s.ensureActiveProfileLocked()
	inner := innerData{
		Profiles:      s.profiles,
		ActiveProfile: s.activeProfile,
	}
	plain, err := json.Marshal(inner)
	if err != nil {
		return fmt.Errorf("encoding store payload: %w", err)
	}

	var env encryptedEnvelope
	switch s.method {
	case encryptionMethodGPG:
		payload, err := gpgEncrypt(s.gpgKey, plain)
		if err != nil {
			return fmt.Errorf("encrypting with gpg: %w", err)
		}
		env = encryptedEnvelope{Version: storePayloadVersion, Method: encryptionMethodGPG, GpgKey: s.gpgKey, Payload: payload}
	case encryptionMethodPassword:
		env, err = passwordEncrypt(plain, s.password)
		if err != nil {
			return err
		}
	default:
		return fmt.Errorf("unknown method %q", s.method)
	}

	wrapped, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("encoding envelope: %w", err)
	}

	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("creating config dir: %w", err)
	}
	if err := atomicWriteFile(s.path, wrapped, 0o600); err != nil {
		return fmt.Errorf("writing context store: %w", err)
	}
	s.rawEnv = &env
	return nil
}

func atomicWriteFile(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".contexts.enc.tmp-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpPath)
		}
	}()
	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return err
	}
	cleanup = false
	return nil
}

// --- encryption helpers ---

func passwordEncrypt(plaintext []byte, password string) (encryptedEnvelope, error) {
	salt := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return encryptedEnvelope{}, fmt.Errorf("generating salt: %w", err)
	}
	key := deriveKey(password, salt)
	block, err := aes.NewCipher(key)
	if err != nil {
		return encryptedEnvelope{}, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return encryptedEnvelope{}, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return encryptedEnvelope{}, fmt.Errorf("generating nonce: %w", err)
	}
	ct := gcm.Seal(nil, nonce, plaintext, nil)
	return encryptedEnvelope{
		Version:    storePayloadVersion,
		Method:     encryptionMethodPassword,
		Salt:       base64.StdEncoding.EncodeToString(salt),
		Nonce:      base64.StdEncoding.EncodeToString(nonce),
		Ciphertext: base64.StdEncoding.EncodeToString(ct),
	}, nil
}

func passwordDecrypt(env encryptedEnvelope, password string) ([]byte, error) {
	salt, err := base64.StdEncoding.DecodeString(env.Salt)
	if err != nil {
		return nil, fmt.Errorf("decoding salt: %w", err)
	}
	nonce, err := base64.StdEncoding.DecodeString(env.Nonce)
	if err != nil {
		return nil, fmt.Errorf("decoding nonce: %w", err)
	}
	ct, err := base64.StdEncoding.DecodeString(env.Ciphertext)
	if err != nil {
		return nil, fmt.Errorf("decoding ciphertext: %w", err)
	}
	key := deriveKey(password, salt)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	plain, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return nil, errors.New("decryption failed — wrong password?")
	}
	return plain, nil
}

func deriveKey(password string, salt []byte) []byte {
	return argon2.IDKey([]byte(password), salt, argon2Time, argon2Memory, argon2Threads, argon2KeyLen)
}

func gpgEncrypt(recipient string, plaintext []byte) (string, error) {
	cmd := exec.Command("gpg", "--batch", "--yes", "--armor", "--trust-model", "always", "-r", recipient, "--encrypt")
	cmd.Stdin = bytes.NewReader(plaintext)
	var out, stderr bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("gpg encrypt: %w (%s)", err, strings.TrimSpace(stderr.String()))
	}
	return out.String(), nil
}

func gpgDecrypt(payload string) ([]byte, error) {
	cmd := exec.Command("gpg", "--batch", "--yes", "--decrypt")
	cmd.Stdin = strings.NewReader(payload)
	var out, stderr bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("gpg decrypt: %w (%s)", err, strings.TrimSpace(stderr.String()))
	}
	return out.Bytes(), nil
}

// ListGPGKeys returns available GPG secret keys.
func ListGPGKeys() ([]GPGKeyInfo, error) {
	cmd := exec.Command("gpg", "--list-secret-keys", "--with-colons")
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("gpg not available: %w", err)
	}

	var keys []GPGKeyInfo
	var current *GPGKeyInfo
	for _, line := range strings.Split(string(out), "\n") {
		parts := strings.Split(line, ":")
		if len(parts) < 2 {
			continue
		}
		switch parts[0] {
		case "sec":
			id := ""
			if len(parts) > 4 {
				id = parts[4]
			}
			current = &GPGKeyInfo{ID: id}
		case "uid":
			if current != nil && len(parts) > 9 {
				uid := parts[9]
				if n, e, ok := parseUID(uid); ok {
					current.Name = n
					current.Email = e
				} else {
					current.Name = uid
				}
				keys = append(keys, *current)
				current = nil
			}
		}
	}
	return keys, nil
}

func parseUID(uid string) (name, email string, ok bool) {
	lt := strings.LastIndex(uid, "<")
	gt := strings.LastIndex(uid, ">")
	if lt < 0 || gt < 0 || gt <= lt {
		return "", "", false
	}
	email = uid[lt+1 : gt]
	name = strings.TrimSpace(uid[:lt])
	return name, email, true
}

// ListKubeconfigContexts reads the system kubeconfig and returns available contexts.
func ListKubeconfigContexts() ([]KubeconfigContextInfo, error) {
	path := os.Getenv("KUBECONFIG")
	if path == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		path = filepath.Join(home, ".kube", "config")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("reading kubeconfig: %w", err)
	}
	cfg, err := clientcmd.Load(data)
	if err != nil {
		return nil, fmt.Errorf("parsing kubeconfig: %w", err)
	}
	var result []KubeconfigContextInfo
	for name, ctx := range cfg.Contexts {
		result = append(result, KubeconfigContextInfo{Name: name, Cluster: ctx.Cluster, User: ctx.AuthInfo})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, nil
}

// ExtractContext extracts a single named context from a kubeconfig (bytes) and
// returns a minimal self-contained kubeconfig YAML string with current-context set.
func ExtractContext(kubeconfigData []byte, contextName string) (string, error) {
	cfg, err := clientcmd.Load(kubeconfigData)
	if err != nil {
		return "", fmt.Errorf("parsing kubeconfig: %w", err)
	}
	ctx, ok := cfg.Contexts[contextName]
	if !ok {
		return "", fmt.Errorf("context %q not found in kubeconfig", contextName)
	}
	cluster := cfg.Clusters[ctx.Cluster]
	if cluster == nil {
		return "", fmt.Errorf("cluster %q not found", ctx.Cluster)
	}
	user := cfg.AuthInfos[ctx.AuthInfo]
	if user == nil {
		user = &clientcmdapi.AuthInfo{}
	}

	minimal := clientcmdapi.NewConfig()
	minimal.CurrentContext = contextName
	minimal.Contexts[contextName] = ctx
	minimal.Clusters[ctx.Cluster] = cluster
	minimal.AuthInfos[ctx.AuthInfo] = user

	out, err := clientcmd.Write(*minimal)
	if err != nil {
		return "", fmt.Errorf("serializing kubeconfig: %w", err)
	}
	return string(out), nil
}

// ExtractContextFromSystemKubeconfig extracts a context from the system ~/.kube/config.
func ExtractContextFromSystemKubeconfig(contextName string) (string, error) {
	path := os.Getenv("KUBECONFIG")
	if path == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		path = filepath.Join(home, ".kube", "config")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("reading kubeconfig: %w", err)
	}
	return ExtractContext(data, contextName)
}

func resolveStorePath() (string, error) {
	if runtime.GOOS == "linux" || runtime.GOOS == "darwin" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolving home directory: %w", err)
		}
		return filepath.Join(home, ".config", defaultDirName, storeFileName), nil
	}
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("resolving config directory: %w", err)
	}
	return filepath.Join(configDir, defaultDirName, storeFileName), nil
}
