package portforward

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/util/httpstream"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"
)

// --- in-memory fake of an upgraded port-forward connection -----------------

// fakeStream is the client half of a stream. Close half-closes (client
// writes end); Reset tears down both directions.
type fakeStream struct {
	headers http.Header
	r       *io.PipeReader
	w       *io.PipeWriter
	id      uint32
}

func (s *fakeStream) Read(p []byte) (int, error)  { return s.r.Read(p) }
func (s *fakeStream) Write(p []byte) (int, error) { return s.w.Write(p) }
func (s *fakeStream) Close() error                { return s.w.Close() }
func (s *fakeStream) Reset() error {
	_ = s.r.Close()
	return s.w.Close()
}
func (s *fakeStream) Headers() http.Header { return s.headers }
func (s *fakeStream) Identifier() uint32   { return s.id }

// fakeConn plays the kubelet: data streams echo, error streams carry errMsg.
type fakeConn struct {
	errMsg    string
	closed    chan bool
	closeOnce sync.Once
	nextID    atomic.Uint32
	ports     sync.Map // port header values seen
}

func newFakeConn() *fakeConn { return &fakeConn{closed: make(chan bool)} }

func (c *fakeConn) CreateStream(h http.Header) (httpstream.Stream, error) {
	select {
	case <-c.closed:
		return nil, errors.New("connection closed")
	default:
	}
	c.ports.Store(h.Get(corev1.PortHeader), true)
	clientR, serverW := io.Pipe()
	serverR, clientW := io.Pipe()
	s := &fakeStream{headers: h.Clone(), r: clientR, w: clientW, id: c.nextID.Add(1)}
	go func() {
		<-c.closed
		_ = serverW.CloseWithError(errors.New("connection closed"))
		_ = serverR.CloseWithError(errors.New("connection closed"))
	}()
	switch h.Get(corev1.StreamType) {
	case corev1.StreamTypeError:
		go func() {
			if c.errMsg != "" {
				_, _ = serverW.Write([]byte(c.errMsg))
			}
			_ = serverW.Close()
			_, _ = io.Copy(io.Discard, serverR)
		}()
	default:
		go func() {
			if c.errMsg != "" {
				_ = serverW.Close()
				_, _ = io.Copy(io.Discard, serverR)
				return
			}
			_, _ = io.Copy(serverW, serverR)
			_ = serverW.Close()
		}()
	}
	return s, nil
}

func (c *fakeConn) Close() error {
	c.closeOnce.Do(func() { close(c.closed) })
	return nil
}
func (c *fakeConn) CloseChan() <-chan bool             { return c.closed }
func (c *fakeConn) SetIdleTimeout(time.Duration)       {}
func (c *fakeConn) RemoveStreams(...httpstream.Stream) {}

func (c *fakeConn) isClosed() bool {
	select {
	case <-c.closed:
		return true
	default:
		return false
	}
}

// --- helpers ----------------------------------------------------------------

type harness struct {
	m      *Manager
	mu     sync.Mutex
	conns  []*fakeConn
	dialFn func(ns, pod string) (httpstream.Connection, error)
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	client := fake.NewClientset(testPod("p", true, time.Now(),
		corev1.ContainerPort{Name: "http", ContainerPort: 3000}))
	h := &harness{}
	h.dialFn = func(string, string) (httpstream.Connection, error) {
		c := newFakeConn()
		h.mu.Lock()
		h.conns = append(h.conns, c)
		h.mu.Unlock()
		return c, nil
	}
	h.m = NewManager(
		func(string) (kubernetes.Interface, *rest.Config, error) { return client, &rest.Config{}, nil },
		func(_ *rest.Config, _ kubernetes.Interface, ns, pod string) (httpstream.Connection, error) {
			return h.dialFn(ns, pod)
		},
	)
	t.Cleanup(h.m.StopAll)
	return h
}

func (h *harness) conn(i int) *fakeConn {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.conns[i]
}

func podTarget(ctx string) Target {
	return Target{Context: ctx, Namespace: "ns", Kind: KindPod, Name: "p", RemotePort: "http"}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func waitStatus(t *testing.T, m *Manager, id, status string) Info {
	t.Helper()
	var info Info
	waitFor(t, "status "+status, func() bool {
		var ok bool
		info, ok = m.Get(id)
		return ok && info.Status == status
	})
	return info
}

func dialLocal(t *testing.T, port int) net.Conn {
	t.Helper()
	c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// --- tests ------------------------------------------------------------------

func TestBindsLoopbackOnly(t *testing.T) {
	h := newHarness(t)
	info, err := h.m.Start(context.Background(), podTarget("c"), 0)
	if err != nil {
		t.Fatal(err)
	}
	if info.Address != "127.0.0.1" || info.LocalPort == 0 {
		t.Fatalf("info = %+v", info)
	}
	h.m.mu.Lock()
	addr := h.m.forwards[info.ID].listener.Addr().(*net.TCPAddr)
	h.m.mu.Unlock()
	if !addr.IP.Equal(net.IPv4(127, 0, 0, 1)) {
		t.Fatalf("listener bound to %v, want 127.0.0.1 only", addr.IP)
	}

	// Not reachable on any non-loopback interface address.
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		ipn, ok := a.(*net.IPNet)
		if !ok || ipn.IP.IsLoopback() || ipn.IP.To4() == nil {
			continue
		}
		c, err := net.DialTimeout("tcp", net.JoinHostPort(ipn.IP.String(), fmt.Sprint(info.LocalPort)), 300*time.Millisecond)
		if err == nil {
			_ = c.Close()
			t.Fatalf("forward reachable on %s", ipn.IP)
		}
	}
}

func TestLifecycleStartForwardStop(t *testing.T) {
	h := newHarness(t)
	info, err := h.m.Start(context.Background(), podTarget("c"), 0)
	if err != nil {
		t.Fatal(err)
	}
	if info.Pod != "p" || info.PodPort != 3000 || info.ID == "" {
		t.Fatalf("info = %+v", info)
	}
	waitStatus(t, h.m, info.ID, StatusRunning)

	c := dialLocal(t, info.LocalPort)
	if _, err := c.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 5)
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := io.ReadFull(c, buf); err != nil || string(buf) != "hello" {
		t.Fatalf("echo = %q, %v", buf, err)
	}
	if _, ok := h.conn(0).ports.Load("3000"); !ok {
		t.Fatal("streams did not target resolved pod port 3000")
	}
	got, _ := h.m.Get(info.ID)
	if got.Connections != 1 || got.TotalConnections != 1 {
		t.Fatalf("connections = %d/%d, want 1/1", got.Connections, got.TotalConnections)
	}
	_ = c.Close()
	waitFor(t, "connection released", func() bool {
		i, _ := h.m.Get(info.ID)
		return i.Connections == 0
	})

	if l := h.m.List(); len(l) != 1 || l[0].ID != info.ID {
		t.Fatalf("list = %+v", l)
	}
	final, ok := h.m.Stop(info.ID)
	if !ok || final.Status != StatusStopped || final.StoppedAt == nil {
		t.Fatalf("stop = %+v %v", final, ok)
	}
	if len(h.m.List()) != 0 {
		t.Fatal("stopped forward still listed")
	}
	if !h.conn(0).isClosed() {
		t.Fatal("stream connection not closed on stop")
	}
	if c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", info.LocalPort), time.Second); err == nil {
		_ = c.Close()
		t.Fatal("local port still listening after stop")
	}
	if _, ok := h.m.Stop(info.ID); ok {
		t.Fatal("second stop should report not found")
	}
}

func TestLostConnectionBecomesError(t *testing.T) {
	h := newHarness(t)
	info, err := h.m.Start(context.Background(), podTarget("c"), 0)
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, h.m, info.ID, StatusRunning)
	_ = h.conn(0).Close() // pod deleted / restarted

	got := waitStatus(t, h.m, info.ID, StatusError)
	if !strings.Contains(got.LastError, "lost connection to pod ns/p") {
		t.Fatalf("last_error = %q", got.LastError)
	}
	// The daemon does not restart it; it stays listed until stopped.
	time.Sleep(50 * time.Millisecond)
	h.mu.Lock()
	n := len(h.conns)
	h.mu.Unlock()
	if n != 1 {
		t.Fatalf("daemon re-dialed (%d dials)", n)
	}
	if _, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", info.LocalPort), time.Second); err == nil {
		t.Fatal("errored forward still listening")
	}
	if _, ok := h.m.Stop(info.ID); !ok {
		t.Fatal("errored forward should be stoppable")
	}
}

func TestDialFailureBecomesError(t *testing.T) {
	h := newHarness(t)
	h.dialFn = func(string, string) (httpstream.Connection, error) {
		return nil, errors.New("pods \"p\" is forbidden")
	}
	info, err := h.m.Start(context.Background(), podTarget("c"), 0)
	if err != nil {
		t.Fatal(err)
	}
	got := waitStatus(t, h.m, info.ID, StatusError)
	if !strings.Contains(got.LastError, "forbidden") {
		t.Fatalf("last_error = %q", got.LastError)
	}
}

func TestDialTimeout(t *testing.T) {
	h := newHarness(t)
	release := make(chan struct{})
	late := newFakeConn()
	h.dialFn = func(string, string) (httpstream.Connection, error) {
		<-release
		return late, nil
	}
	h.m.dialTimeout = 50 * time.Millisecond
	info, err := h.m.Start(context.Background(), podTarget("c"), 0)
	if err != nil {
		t.Fatal(err)
	}
	got := waitStatus(t, h.m, info.ID, StatusError)
	if !strings.Contains(got.LastError, "timed out") {
		t.Fatalf("last_error = %q", got.LastError)
	}
	close(release)
	waitFor(t, "late connection closed", late.isClosed)
}

func TestStopWhileStarting(t *testing.T) {
	h := newHarness(t)
	release := make(chan struct{})
	late := newFakeConn()
	h.dialFn = func(string, string) (httpstream.Connection, error) {
		<-release
		return late, nil
	}
	info, err := h.m.Start(context.Background(), podTarget("c"), 0)
	if err != nil {
		t.Fatal(err)
	}
	if info.Status != StatusStarting {
		t.Fatalf("status = %s", info.Status)
	}
	if got, _ := h.m.Stop(info.ID); got.Status != StatusStopped {
		t.Fatalf("status = %s", got.Status)
	}
	close(release)
	waitFor(t, "late connection closed", late.isClosed)
}

func TestConnectionErrorKeepsRunning(t *testing.T) {
	h := newHarness(t)
	h.dialFn = func(string, string) (httpstream.Connection, error) {
		c := newFakeConn()
		c.errMsg = "dial tcp4 127.0.0.1:3000: connect: connection refused"
		return c, nil
	}
	info, err := h.m.Start(context.Background(), podTarget("c"), 0)
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, h.m, info.ID, StatusRunning)
	c := dialLocal(t, info.LocalPort)
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, _ = io.ReadAll(c)
	_ = c.Close()
	waitFor(t, "connection error recorded", func() bool {
		i, _ := h.m.Get(info.ID)
		return strings.Contains(i.ConnectionError, "connection refused")
	})
	if i, _ := h.m.Get(info.ID); i.Status != StatusRunning || i.LastError != "" {
		t.Fatalf("forward should keep running: %+v", i)
	}
}

func TestLocalPortInUse(t *testing.T) {
	h := newHarness(t)
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	port := ln.Addr().(*net.TCPAddr).Port
	_, err = h.m.Start(context.Background(), podTarget("c"), port)
	if err == nil || !strings.Contains(err.Error(), "address already in use") {
		t.Fatalf("err = %v", err)
	}
	if len(h.m.List()) != 0 {
		t.Fatal("failed start should not leave a record")
	}
}

func TestStartErrorsAreSynchronous(t *testing.T) {
	h := newHarness(t)
	if _, err := h.m.Start(context.Background(), Target{Namespace: "ns", Kind: KindPod, Name: "missing", RemotePort: "80"}, 0); err == nil {
		t.Fatal("expected error for missing pod")
	}
	if _, err := h.m.Start(context.Background(), podTarget("c"), 70000); err == nil {
		t.Fatal("expected error for invalid local port")
	}
	m := NewManager(func(string) (kubernetes.Interface, *rest.Config, error) {
		return nil, nil, errors.New("exec plugin not approved")
	}, nil)
	if _, err := m.Start(context.Background(), podTarget("c"), 0); err == nil || !strings.Contains(err.Error(), "not approved") {
		t.Fatalf("err = %v", err)
	}
}

func TestStopAllAndStopContext(t *testing.T) {
	h := newHarness(t)
	a, _ := h.m.Start(context.Background(), podTarget("one"), 0)
	b, _ := h.m.Start(context.Background(), podTarget("two"), 0)
	c, _ := h.m.Start(context.Background(), podTarget("two"), 0)
	for _, id := range []string{a.ID, b.ID, c.ID} {
		waitStatus(t, h.m, id, StatusRunning)
	}
	h.m.StopContext("two")
	l := h.m.List()
	if len(l) != 1 || l[0].ID != a.ID {
		t.Fatalf("after StopContext: %+v", l)
	}
	h.m.StopAll()
	if len(h.m.List()) != 0 {
		t.Fatal("StopAll left forwards")
	}
	for i := 0; i < 3; i++ {
		if !h.conn(i).isClosed() {
			t.Fatalf("conn %d not closed", i)
		}
	}
}
