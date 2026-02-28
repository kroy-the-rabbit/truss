package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/kroy/truss/backend/internal/contextstore"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// makeInitializedStore creates a password-encrypted store in a temp directory.
// The store is ready to use (initialized, unlocked).
func makeInitializedStore(t *testing.T) *contextstore.Store {
	t.Helper()
	// Point UserConfigDir to a temp dir so New() creates a fresh store.
	// t.Setenv restores HOME/XDG_CONFIG_HOME automatically after the test.
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("XDG_CONFIG_HOME", tmp)

	s, err := contextstore.New()
	if err != nil {
		t.Fatalf("contextstore.New: %v", err)
	}
	if err := s.Initialize("password", "", "testpassword"); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	return s
}

// prometheusService builds a minimal corev1.Service for testing.
func prometheusService(name string, labels map[string]string, ports []int32) corev1.Service {
	svc := corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:   name,
			Labels: labels,
		},
	}
	for _, p := range ports {
		svc.Spec.Ports = append(svc.Spec.Ports, corev1.ServicePort{Port: p})
	}
	return svc
}

func TestIsPrometheusService(t *testing.T) {
	tests := []struct {
		name    string
		svcName string
		labels  map[string]string
		want    bool
	}{
		{
			name:    "known name prometheus-server",
			svcName: "prometheus-server",
			want:    true,
		},
		{
			name:    "known name prometheus-operated",
			svcName: "prometheus-operated",
			want:    true,
		},
		{
			name:    "known name prometheus",
			svcName: "prometheus",
			want:    true,
		},
		{
			name:    "known name kube-prometheus-stack-prometheus",
			svcName: "kube-prometheus-stack-prometheus",
			want:    true,
		},
		{
			name:    "known name thanos-querier",
			svcName: "thanos-querier",
			want:    true,
		},
		{
			name:    "label app=prometheus",
			svcName: "some-service",
			labels:  map[string]string{"app": "prometheus"},
			want:    true,
		},
		{
			name:    "label app.kubernetes.io/name=prometheus",
			svcName: "some-service",
			labels:  map[string]string{"app.kubernetes.io/name": "prometheus"},
			want:    true,
		},
		{
			name:    "unrelated service",
			svcName: "my-app",
			labels:  map[string]string{"app": "my-app"},
			want:    false,
		},
		{
			name:    "empty name no labels",
			svcName: "web",
			want:    false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc := prometheusService(tt.svcName, tt.labels, nil)
			got := isPrometheusService(svc)
			if got != tt.want {
				t.Errorf("isPrometheusService(%q, labels=%v) = %v, want %v", tt.svcName, tt.labels, got, tt.want)
			}
		})
	}
}

func TestFindPrometheusPort(t *testing.T) {
	tests := []struct {
		name  string
		ports []int32
		want  int
	}{
		{
			name:  "port 9090 preferred",
			ports: []int32{8080, 9090, 3000},
			want:  9090,
		},
		{
			name:  "only port 9090",
			ports: []int32{9090},
			want:  9090,
		},
		{
			name:  "no 9090, returns first port >= 1024",
			ports: []int32{1025},
			want:  1025,
		},
		{
			name:  "empty ports returns default 9090",
			ports: nil,
			want:  9090,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc := prometheusService("prom", nil, tt.ports)
			got := findPrometheusPort(svc)
			if got != tt.want {
				t.Errorf("findPrometheusPort(ports=%v) = %d, want %d", tt.ports, got, tt.want)
			}
		})
	}
}

func TestFindPrometheusPortHTTPNameFallback(t *testing.T) {
	// When no port 9090 present, a port named "http" or "web" wins over other ports.
	svc := corev1.Service{
		Spec: corev1.ServiceSpec{
			Ports: []corev1.ServicePort{
				{Name: "grpc", Port: 9000},
				{Name: "http", Port: 8080},
				{Name: "metrics", Port: 8888},
			},
		},
	}
	got := findPrometheusPort(svc)
	if got != 8080 {
		t.Errorf("expected 8080 (http port), got %d", got)
	}
}

func TestHandleMetricsPrometheusURLSchemeValidation(t *testing.T) {
	s := makeInitializedStore(t)
	srv := &Server{store: s}

	tests := []struct {
		name       string
		body       string
		wantStatus int
	}{
		{
			name:       "valid http URL accepted",
			body:       `{"url":"http://prometheus.monitoring.svc:9090"}`,
			wantStatus: http.StatusOK,
		},
		{
			name:       "valid https URL accepted",
			body:       `{"url":"https://prometheus.example.com"}`,
			wantStatus: http.StatusOK,
		},
		{
			name:       "empty URL clears setting",
			body:       `{"url":""}`,
			wantStatus: http.StatusOK,
		},
		{
			name:       "whitespace-only URL treated as empty",
			body:       `{"url":"   "}`,
			wantStatus: http.StatusOK,
		},
		{
			name:       "ftp scheme rejected",
			body:       `{"url":"ftp://evil.com/data"}`,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "javascript scheme rejected",
			body:       `{"url":"javascript:alert(1)"}`,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "file scheme rejected",
			body:       `{"url":"file:///etc/passwd"}`,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "invalid JSON returns 400",
			body:       `not json`,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "GET method rejected",
			body:       "",
			wantStatus: http.StatusMethodNotAllowed,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			method := http.MethodPost
			if tt.name == "GET method rejected" {
				method = http.MethodGet
			}
			r := httptest.NewRequest(method, "/api/metrics/prometheus/url", strings.NewReader(tt.body))
			w := httptest.NewRecorder()
			srv.handleMetricsPrometheusURL(w, r)
			if w.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d (body: %s)", w.Code, tt.wantStatus, w.Body.String())
			}
		})
	}
}

func TestHandleMetricsDiscoverMethodGuard(t *testing.T) {
	srv := &Server{store: &contextstore.Store{}}

	r := httptest.NewRequest(http.MethodPost, "/api/metrics/prometheus/discover", nil)
	w := httptest.NewRecorder()
	srv.handleMetricsDiscover(w, r)
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", w.Code)
	}
}

func TestHandleMetricsQueryRangeMethodGuard(t *testing.T) {
	srv := &Server{store: &contextstore.Store{}}

	r := httptest.NewRequest(http.MethodPost, "/api/metrics/prometheus/query_range", nil)
	w := httptest.NewRecorder()
	srv.handleMetricsQueryRange(w, r)
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", w.Code)
	}
}

func TestHandleMetricsPrometheusURLStoresValue(t *testing.T) {
	s := makeInitializedStore(t)
	srv := &Server{store: s}

	body := bytes.NewBufferString(`{"url":"http://prom.svc:9090"}`)
	r := httptest.NewRequest(http.MethodPost, "/api/metrics/prometheus/url", body)
	w := httptest.NewRecorder()
	srv.handleMetricsPrometheusURL(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	stored, ok := s.GetSecureValue(prometheusURLKey)
	if !ok {
		t.Fatal("expected prometheus URL to be stored")
	}
	if stored != "http://prom.svc:9090" {
		t.Errorf("stored value = %q, want %q", stored, "http://prom.svc:9090")
	}
}

func TestHandleMetricsPrometheusURLClearsValue(t *testing.T) {
	s := makeInitializedStore(t)
	srv := &Server{store: s}

	// Set then clear.
	if err := s.SetSecureValue(prometheusURLKey, "http://old.svc"); err != nil {
		t.Fatal(err)
	}

	body := bytes.NewBufferString(`{"url":""}`)
	r := httptest.NewRequest(http.MethodPost, "/api/metrics/prometheus/url", body)
	w := httptest.NewRecorder()
	srv.handleMetricsPrometheusURL(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	stored, _ := s.GetSecureValue(prometheusURLKey)
	if stored != "" {
		t.Errorf("expected empty stored URL, got %q", stored)
	}
}

func TestHandleMetricsDiscoverReturnsManualURL(t *testing.T) {
	s := makeInitializedStore(t)
	if err := s.SetSecureValue(prometheusURLKey, "http://external-prom:9090"); err != nil {
		t.Fatal(err)
	}
	srv := &Server{store: s, kubeMgr: nil}

	r := httptest.NewRequest(http.MethodGet, "/api/metrics/prometheus/discover?context=test", nil)
	w := httptest.NewRecorder()
	srv.handleMetricsDiscover(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var resp prometheusDiscoverResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if !resp.Found {
		t.Fatal("expected found=true for manually-set URL")
	}
	if resp.Endpoint == nil || resp.Endpoint.URL != "http://external-prom:9090" {
		t.Errorf("unexpected endpoint: %+v", resp.Endpoint)
	}
	if resp.Endpoint.Source != "manual" {
		t.Errorf("expected source=manual, got %q", resp.Endpoint.Source)
	}

}
