// Package portforward runs Kubernetes port-forwards inside the daemon using
// the encrypted store's credentials (via kube.Manager), so forwards always hit
// the cluster the vault context points at.
//
// The daemon never restarts a broken forward on its own: it reports status
// "error" with last_error, and the Electron main process decides whether to
// restart (one supervision policy, in one place).
package portforward

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"sort"
	"strconv"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/util/httpstream"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// ListenAddress is the only address forwards bind to. Never 0.0.0.0 or ::.
const ListenAddress = "127.0.0.1"

// Forward statuses.
const (
	StatusStarting = "starting"
	StatusRunning  = "running"
	StatusError    = "error"
	StatusStopped  = "stopped"
)

const (
	defaultDialTimeout    = 30 * time.Second
	defaultResolveTimeout = 15 * time.Second
)

// ClientFunc returns the typed client and rest config for a context.
type ClientFunc func(contextName string) (kubernetes.Interface, *rest.Config, error)

// DialFunc opens a port-forward stream connection to a pod.
type DialFunc func(cfg *rest.Config, client kubernetes.Interface, namespace, pod string) (httpstream.Connection, error)

// Info is the JSON snapshot of a forward.
type Info struct {
	ID         string  `json:"id"`
	Context    string  `json:"context"`
	Namespace  string  `json:"namespace"`
	Kind       string  `json:"kind"`
	Name       string  `json:"name"`
	RemotePort PortRef `json:"remote_port"`
	// Pod and PodPort are what the target resolved to.
	Pod       string `json:"pod"`
	PodPort   int    `json:"pod_port"`
	Address   string `json:"address"`
	LocalPort int    `json:"local_port"`
	Status    string `json:"status"`
	// LastError is the fatal error that put the forward into status "error".
	LastError string `json:"last_error,omitempty"`
	// ConnectionError is the most recent per-connection failure; the forward
	// keeps listening after these.
	ConnectionError  string     `json:"connection_error,omitempty"`
	Connections      int        `json:"connections"`
	TotalConnections int64      `json:"total_connections"`
	StartedAt        time.Time  `json:"started_at"`
	StoppedAt        *time.Time `json:"stopped_at,omitempty"`
}

// Manager owns all active forwards.
type Manager struct {
	clients        ClientFunc
	dial           DialFunc
	dialTimeout    time.Duration
	resolveTimeout time.Duration

	mu       sync.Mutex
	forwards map[string]*forward
}

// NewManager creates a Manager. A nil dial uses the real SPDY/WebSocket dialer.
func NewManager(clients ClientFunc, dial DialFunc) *Manager {
	if dial == nil {
		dial = dialKube
	}
	return &Manager{
		clients:        clients,
		dial:           dial,
		dialTimeout:    defaultDialTimeout,
		resolveTimeout: defaultResolveTimeout,
		forwards:       make(map[string]*forward),
	}
}

type forward struct {
	mu       sync.Mutex
	info     Info
	listener net.Listener
	conn     httpstream.Connection
	stopCh   chan struct{}
	stopOnce sync.Once
	active   map[net.Conn]struct{}
	reqID    int
}

func newID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// Start resolves the target, binds 127.0.0.1:localPort (0 picks a free port)
// and connects to the pod in the background. Resolution and bind failures are
// returned synchronously; connection failures show up as status "error".
func (m *Manager) Start(ctx context.Context, t Target, localPort int) (Info, error) {
	if err := t.validate(); err != nil {
		return Info{}, err
	}
	if localPort < 0 || localPort > 65535 {
		return Info{}, fmt.Errorf("invalid local_port %d", localPort)
	}
	client, cfg, err := m.clients(t.Context)
	if err != nil {
		return Info{}, err
	}
	rctx, cancel := context.WithTimeout(ctx, m.resolveTimeout)
	defer cancel()
	res, err := Resolve(rctx, client, t)
	if err != nil {
		return Info{}, err
	}

	ln, err := net.Listen("tcp4", net.JoinHostPort(ListenAddress, strconv.Itoa(localPort)))
	if err != nil {
		return Info{}, fmt.Errorf("unable to listen on %s:%d: %w", ListenAddress, localPort, err)
	}

	f := &forward{
		info: Info{
			ID:         newID(),
			Context:    t.Context,
			Namespace:  t.Namespace,
			Kind:       t.Kind,
			Name:       t.Name,
			RemotePort: t.RemotePort,
			Pod:        res.Pod,
			PodPort:    res.Port,
			Address:    ListenAddress,
			LocalPort:  ln.Addr().(*net.TCPAddr).Port,
			Status:     StatusStarting,
			StartedAt:  time.Now().UTC(),
		},
		listener: ln,
		stopCh:   make(chan struct{}),
		active:   make(map[net.Conn]struct{}),
	}
	m.mu.Lock()
	m.forwards[f.info.ID] = f
	m.mu.Unlock()

	go m.run(f, cfg, client)
	return f.snapshot(), nil
}

// List returns all forwards, oldest first.
func (m *Manager) List() []Info {
	m.mu.Lock()
	out := make([]Info, 0, len(m.forwards))
	for _, f := range m.forwards {
		out = append(out, f.snapshot())
	}
	m.mu.Unlock()
	sort.Slice(out, func(i, j int) bool {
		if !out[i].StartedAt.Equal(out[j].StartedAt) {
			return out[i].StartedAt.Before(out[j].StartedAt)
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// Get returns one forward's snapshot.
func (m *Manager) Get(id string) (Info, bool) {
	m.mu.Lock()
	f, ok := m.forwards[id]
	m.mu.Unlock()
	if !ok {
		return Info{}, false
	}
	return f.snapshot(), true
}

// Stop stops and forgets a forward. It returns the final snapshot.
func (m *Manager) Stop(id string) (Info, bool) {
	m.mu.Lock()
	f, ok := m.forwards[id]
	delete(m.forwards, id)
	m.mu.Unlock()
	if !ok {
		return Info{}, false
	}
	f.stop("")
	return f.snapshot(), true
}

// StopAll stops every forward (store lock, profile switch, shutdown).
func (m *Manager) StopAll() {
	m.stopMatching(func(*forward) bool { return true })
}

// StopContext stops every forward for a context (context deleted).
func (m *Manager) StopContext(contextName string) {
	m.stopMatching(func(f *forward) bool { return f.info.Context == contextName })
}

func (m *Manager) stopMatching(match func(*forward) bool) {
	m.mu.Lock()
	var victims []*forward
	for id, f := range m.forwards {
		f.mu.Lock()
		hit := match(f)
		f.mu.Unlock()
		if hit {
			victims = append(victims, f)
			delete(m.forwards, id)
		}
	}
	m.mu.Unlock()
	for _, f := range victims {
		f.stop("")
	}
}

func (m *Manager) run(f *forward, cfg *rest.Config, client kubernetes.Interface) {
	ch := make(chan dialResult, 1)
	go func() {
		conn, err := m.dial(cfg, client, f.info.Namespace, f.info.Pod)
		ch <- dialResult{conn, err}
	}()

	var res dialResult
	select {
	case res = <-ch:
	case <-f.stopCh:
		go closeLateConn(ch)
		return
	case <-time.After(m.dialTimeout):
		go closeLateConn(ch)
		f.stop(fmt.Sprintf("timed out connecting to pod %s/%s", f.info.Namespace, f.info.Pod))
		return
	}
	if res.err != nil {
		f.stop(res.err.Error())
		return
	}

	f.mu.Lock()
	select {
	case <-f.stopCh:
		f.mu.Unlock()
		_ = res.conn.Close()
		return
	default:
	}
	f.conn = res.conn
	f.info.Status = StatusRunning
	f.mu.Unlock()

	go f.acceptLoop()

	select {
	case <-f.stopCh:
	case <-res.conn.CloseChan():
		f.stop(fmt.Sprintf("lost connection to pod %s/%s", f.info.Namespace, f.info.Pod))
	}
}

type dialResult struct {
	conn httpstream.Connection
	err  error
}

// closeLateConn closes a connection whose dial finished after we gave up.
func closeLateConn(ch <-chan dialResult) {
	if r := <-ch; r.conn != nil {
		_ = r.conn.Close()
	}
}

func (f *forward) snapshot() Info {
	f.mu.Lock()
	defer f.mu.Unlock()
	info := f.info
	info.Connections = len(f.active)
	if f.info.StoppedAt != nil {
		t := *f.info.StoppedAt
		info.StoppedAt = &t
	}
	return info
}

// stop tears the forward down. An empty reason means a deliberate stop
// (status "stopped"); otherwise the forward ends in status "error".
func (f *forward) stop(reason string) {
	f.stopOnce.Do(func() {
		f.mu.Lock()
		now := time.Now().UTC()
		f.info.StoppedAt = &now
		if reason == "" {
			f.info.Status = StatusStopped
		} else {
			f.info.Status = StatusError
			f.info.LastError = reason
		}
		close(f.stopCh)
		ln, conn := f.listener, f.conn
		conns := make([]net.Conn, 0, len(f.active))
		for c := range f.active {
			conns = append(conns, c)
		}
		f.mu.Unlock()

		_ = ln.Close()
		if conn != nil {
			_ = conn.Close()
		}
		for _, c := range conns {
			_ = c.Close()
		}
	})
}

func (f *forward) acceptLoop() {
	for {
		c, err := f.listener.Accept()
		if err != nil {
			return
		}
		f.mu.Lock()
		select {
		case <-f.stopCh:
			f.mu.Unlock()
			_ = c.Close()
			return
		default:
		}
		f.active[c] = struct{}{}
		f.info.TotalConnections++
		f.reqID++
		id := f.reqID
		conn := f.conn
		f.mu.Unlock()
		go f.handle(c, conn, id)
	}
}

func (f *forward) setConnError(err error) {
	f.mu.Lock()
	f.info.ConnectionError = err.Error()
	f.mu.Unlock()
}

// handle copies one local connection over a pair of error/data streams,
// following the kubelet port-forward protocol (as client-go's PortForwarder).
func (f *forward) handle(local net.Conn, conn httpstream.Connection, requestID int) {
	defer func() {
		_ = local.Close()
		f.mu.Lock()
		delete(f.active, local)
		f.mu.Unlock()
	}()

	port := strconv.Itoa(f.info.PodPort)
	headers := http.Header{}
	headers.Set(corev1.StreamType, corev1.StreamTypeError)
	headers.Set(corev1.PortHeader, port)
	headers.Set(corev1.PortForwardRequestIDHeader, strconv.Itoa(requestID))
	errorStream, err := conn.CreateStream(headers)
	if err != nil {
		f.setConnError(fmt.Errorf("creating error stream: %w", err))
		return
	}
	// We never write to the error stream.
	_ = errorStream.Close()
	defer conn.RemoveStreams(errorStream)

	errCh := make(chan error, 1)
	go func() {
		msg, err := io.ReadAll(errorStream)
		switch {
		case err != nil:
			errCh <- fmt.Errorf("reading error stream: %w", err)
		case len(msg) > 0:
			errCh <- fmt.Errorf("error forwarding port %s to pod %s: %s", port, f.info.Pod, string(msg))
		default:
			errCh <- nil
		}
	}()

	headers.Set(corev1.StreamType, corev1.StreamTypeData)
	dataStream, err := conn.CreateStream(headers)
	if err != nil {
		f.setConnError(fmt.Errorf("creating data stream: %w", err))
		return
	}
	defer conn.RemoveStreams(dataStream)

	localDone := make(chan struct{})
	remoteDone := make(chan struct{})
	go func() {
		_, _ = io.Copy(local, dataStream)
		close(remoteDone)
	}()
	go func() {
		// Half-close the data stream once the local side is done writing.
		defer func() { _ = dataStream.Close() }()
		_, _ = io.Copy(dataStream, local)
		close(localDone)
	}()

	select {
	case <-remoteDone:
	case <-localDone:
		select {
		case <-remoteDone:
		case <-f.stopCh:
		}
	case <-f.stopCh:
	}
	// Discard unsent data so the error stream read cannot block.
	_ = dataStream.Reset()

	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, io.EOF) {
			f.setConnError(err)
		}
	case <-f.stopCh:
	}
}
