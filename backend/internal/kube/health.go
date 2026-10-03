package kube

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	osexec "os/exec"
	"sort"
	"strings"
	"sync"
	"time"

	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

// healthState is the per-context circuit-breaker record.
type healthState struct {
	health ContextHealth
	gen    uint64 // bumps on every transition; guards async stderr capture
}

type healthTracker struct {
	mu        sync.RWMutex
	health    map[string]*healthState
	gen       uint64
	nextSubID int
	subs      map[int]chan ContextHealth
}

// Tunables (package vars so tests can shorten them).
var (
	stderrCaptureTimeout = 15 * time.Second
	stderrCaptureLimit   = 4096
	reauthProbeTimeout   = 20 * time.Second
	requestTimeout       = 30 * time.Second
)

func (m *Manager) tracker() *healthTracker {
	m.healthOnce.Do(func() {
		if m.ht == nil {
			m.ht = &healthTracker{
				health: make(map[string]*healthState),
				subs:   make(map[int]chan ContextHealth),
			}
		}
	})
	return m.ht
}

// Health returns the recorded health for a context, or state "unknown".
func (m *Manager) Health(contextName string) ContextHealth {
	t := m.tracker()
	t.mu.RLock()
	defer t.mu.RUnlock()
	if st, ok := t.health[contextName]; ok {
		return st.health
	}
	return ContextHealth{Context: contextName, State: StateUnknown}
}

// AllHealth returns health for every context with recorded state, sorted by name.
func (m *Manager) AllHealth() []ContextHealth {
	t := m.tracker()
	t.mu.RLock()
	out := make([]ContextHealth, 0, len(t.health))
	for _, st := range t.health {
		out = append(out, st.health)
	}
	t.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool { return out[i].Context < out[j].Context })
	return out
}

// InErrorState reports whether the context's last recorded outcome was a failure.
func (m *Manager) InErrorState(contextName string) bool {
	t := m.tracker()
	t.mu.RLock()
	defer t.mu.RUnlock()
	st, ok := t.health[contextName]
	return ok && st.health.State == StateError
}

// breakerError returns the cached classified error when the context's breaker is open.
func (m *Manager) breakerError(contextName string) error {
	t := m.tracker()
	t.mu.RLock()
	defer t.mu.RUnlock()
	st, ok := t.health[contextName]
	if !ok || st.health.State != StateError || !st.health.Kind.IsAuth() {
		return nil
	}
	return &AuthError{Health: st.health}
}

// RecordSuccess marks a context healthy.
func (m *Manager) RecordSuccess(contextName string) {
	if contextName == "" {
		return
	}
	t := m.tracker()
	t.mu.RLock()
	st, ok := t.health[contextName]
	alreadyOK := ok && st.health.State == StateOK
	t.mu.RUnlock()
	if alreadyOK {
		return
	}

	t.mu.Lock()
	if st, ok := t.health[contextName]; ok && st.health.State == StateOK {
		t.mu.Unlock()
		return
	}
	t.gen++
	h := ContextHealth{
		Context: contextName,
		State:   StateOK,
		Since:   time.Now().UTC().Format(time.RFC3339),
	}
	t.health[contextName] = &healthState{health: h, gen: t.gen}
	t.notifyLocked(h)
	t.mu.Unlock()
}

// RecordError classifies err and records it against the context. UNKNOWN
// errors (and caller cancellations) are not recorded. Returns the kind.
func (m *Manager) RecordError(contextName string, err error) Kind {
	if err == nil || contextName == "" {
		return KindNone
	}
	k := Classify(err)
	if k == KindUnknown || k == KindNone {
		return k
	}
	var ae *AuthError
	if errors.As(err, &ae) {
		// Short-circuited by the breaker; state is already recorded.
		return k
	}
	m.recordKind(contextName, k, err)
	return k
}

func (m *Manager) recordKind(contextName string, k Kind, err error) {
	t := m.tracker()
	t.mu.Lock()
	prev, ok := t.health[contextName]
	if ok && prev.health.State == StateError && prev.health.Kind == k {
		t.mu.Unlock()
		return
	}
	t.gen++
	gen := t.gen
	h := ContextHealth{
		Context: contextName,
		State:   StateError,
		Kind:    k,
		Message: HealthMessage(contextName, k, err),
		Since:   time.Now().UTC().Format(time.RFC3339),
	}
	execCfg := m.execConfigFor(contextName)
	if execCfg != nil && k.IsAuth() {
		h.PluginCommand = PluginCommandLine(execCfg)
		h.SuggestedCommand = SuggestedCommand(execCfg)
	}
	t.health[contextName] = &healthState{health: h, gen: gen}
	t.notifyLocked(h)
	t.mu.Unlock()

	if execCfg != nil && (k == KindAuthRequired || k == KindAuthInteractiveUnsupported) {
		go m.captureStderr(contextName, gen, execCfg)
	}
}

// ResetHealth forgets the recorded state for a context (closing its breaker).
func (m *Manager) ResetHealth(contextName string) {
	t := m.tracker()
	t.mu.Lock()
	defer t.mu.Unlock()
	if _, ok := t.health[contextName]; !ok {
		return
	}
	t.gen++
	delete(t.health, contextName)
	t.notifyLocked(ContextHealth{Context: contextName, State: StateUnknown})
}

func (m *Manager) resetAllHealth() {
	t := m.tracker()
	t.mu.Lock()
	defer t.mu.Unlock()
	t.gen++
	t.health = make(map[string]*healthState)
}

// SubscribeHealth returns a stream of health transitions for all contexts.
func (m *Manager) SubscribeHealth() (<-chan ContextHealth, func()) {
	t := m.tracker()
	t.mu.Lock()
	defer t.mu.Unlock()
	id := t.nextSubID
	t.nextSubID++
	ch := make(chan ContextHealth, 16)
	t.subs[id] = ch
	var once sync.Once
	return ch, func() {
		once.Do(func() {
			t.mu.Lock()
			defer t.mu.Unlock()
			delete(t.subs, id)
			close(ch)
		})
	}
}

func (t *healthTracker) notifyLocked(h ContextHealth) {
	for _, ch := range t.subs {
		select {
		case ch <- h:
		default:
		}
	}
}

func (m *Manager) execConfigFor(contextName string) *clientcmdapi.ExecConfig {
	if m.store == nil {
		return nil
	}
	entry, ok := m.store.GetContextEntry(contextName)
	if !ok {
		return nil
	}
	execCfg, err := ExecConfigFromKubeconfig(entry.Kubeconfig)
	if err != nil {
		return nil
	}
	return execCfg
}

// captureStderr runs the credential plugin once, non-interactively, to capture
// its stderr (client-go sends plugin stderr to the daemon's own stderr, where
// the user never sees it). Stdout (which may carry a token) is discarded.
func (m *Manager) captureStderr(contextName string, gen uint64, execCfg *clientcmdapi.ExecConfig) {
	stderr := RunPluginForStderr(execCfg)
	if stderr == "" {
		return
	}
	t := m.tracker()
	t.mu.Lock()
	defer t.mu.Unlock()
	st, ok := t.health[contextName]
	if !ok || st.gen != gen {
		return
	}
	st.health.Stderr = stderr
	t.notifyLocked(st.health)
}

type cappedBuffer struct {
	buf   []byte
	limit int
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	if room := c.limit - len(c.buf); room > 0 {
		if len(p) > room {
			c.buf = append(c.buf, p[:room]...)
		} else {
			c.buf = append(c.buf, p...)
		}
	}
	return len(p), nil
}

// RunPluginForStderr executes the exec plugin argv directly (no shell) with
// KUBERNETES_EXEC_INFO set to a non-interactive request and stdin at
// /dev/null, returning at most 4KB of stderr.
func RunPluginForStderr(execCfg *clientcmdapi.ExecConfig) string {
	if execCfg == nil || strings.TrimSpace(execCfg.Command) == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), stderrCaptureTimeout)
	defer cancel()

	apiVersion := execCfg.APIVersion
	if apiVersion == "" {
		apiVersion = "client.authentication.k8s.io/v1beta1"
	}
	info, _ := json.Marshal(map[string]any{
		"kind":       "ExecCredential",
		"apiVersion": apiVersion,
		"spec":       map[string]any{"interactive": false},
	})

	cmd := osexec.CommandContext(ctx, strings.TrimSpace(execCfg.Command), execCfg.Args...)
	env := os.Environ()
	for _, e := range execCfg.Env {
		env = append(env, e.Name+"="+e.Value)
	}
	env = append(env, "KUBERNETES_EXEC_INFO="+string(info))
	cmd.Env = env
	cmd.Stdin = nil // /dev/null
	cmd.Stdout = io.Discard
	errBuf := &cappedBuffer{limit: stderrCaptureLimit}
	cmd.Stderr = errBuf
	cmd.WaitDelay = 2 * time.Second

	runErr := cmd.Run()
	out := strings.TrimSpace(string(errBuf.buf))
	if out == "" && runErr != nil && ctx.Err() != nil {
		out = fmt.Sprintf("credential plugin did not finish within %s", stderrCaptureTimeout)
	}
	return out
}

// healthTransport is the outermost RoundTripper for a context's clients. It
// short-circuits requests while the breaker is open (so the exec plugin is
// not re-run) and records request outcomes.
type healthTransport struct {
	m       *Manager
	context string
	base    http.RoundTripper
}

// aggregatedMetricsPrefixes are API paths whose 401s come from aggregated API
// servers rather than the cluster's authenticator; they must not trip the breaker.
var aggregatedMetricsPrefixes = []string{
	"/apis/metrics.k8s.io",
	"/apis/custom.metrics.k8s.io",
	"/apis/external.metrics.k8s.io",
}

func (t *healthTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if err := t.m.breakerError(t.context); err != nil {
		return nil, err
	}
	resp, err := t.base.RoundTrip(req)
	if err != nil {
		switch k := Classify(err); {
		case k.IsAuth(), k == KindUnreachable, k == KindTLS:
			t.m.recordKind(t.context, k, err)
		}
		return nil, err
	}
	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		for _, p := range aggregatedMetricsPrefixes {
			if strings.HasPrefix(req.URL.Path, p) {
				return resp, nil
			}
		}
		t.m.recordKind(t.context, KindAuthRejected, errors.New("the server returned 401 Unauthorized"))
	case resp.StatusCode == http.StatusForbidden, resp.StatusCode >= 500:
		// Per-resource RBAC denials and server errors say nothing about context health.
	default:
		t.m.RecordSuccess(t.context)
	}
	return resp, nil
}

// Reauth closes the breaker for a context, discards its cached client and
// probes the API server's /version endpoint, recording the outcome.
func (m *Manager) Reauth(contextName string) ContextHealth {
	m.ResetHealth(contextName)
	m.InvalidateClient(contextName)
	cs, err := m.GetClientSet(contextName)
	if err != nil {
		if m.RecordError(contextName, err) == KindUnknown {
			m.recordKind(contextName, KindUnknown, err)
		}
		return m.Health(contextName)
	}
	ctx, cancel := context.WithTimeout(context.Background(), reauthProbeTimeout)
	defer cancel()
	err = cs.Discovery.RESTClient().Get().AbsPath("/version").Do(ctx).Error()
	if err != nil {
		if m.RecordError(contextName, err) == KindUnknown {
			m.recordKind(contextName, KindUnknown, err)
		}
	} else {
		m.RecordSuccess(contextName)
	}
	return m.Health(contextName)
}
