package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/rest"
)

const prometheusURLKey = "__truss:prometheus_url"

type prometheusEndpoint struct {
	Namespace string `json:"namespace"`
	Service   string `json:"service"`
	Port      int    `json:"port"`
	Source    string `json:"source"` // "manual" | "autodiscovered"
	URL       string `json:"url,omitempty"`
}

type prometheusDiscoverResponse struct {
	Found    bool                `json:"found"`
	Endpoint *prometheusEndpoint `json:"endpoint,omitempty"`
}

var prometheusNamespaces = []string{
	"monitoring", "prometheus", "kube-prometheus-stack", "observability", "default",
}

var prometheusServiceNames = map[string]bool{
	"prometheus-server":                true,
	"prometheus-operated":              true,
	"prometheus":                       true,
	"kube-prometheus-stack-prometheus": true,
	"thanos-querier":                   true,
	"thanos-query":                     true,
}

func isPrometheusService(svc corev1.Service) bool {
	if prometheusServiceNames[svc.Name] {
		return true
	}
	labels := svc.Labels
	if labels["app"] == "prometheus" {
		return true
	}
	if labels["app.kubernetes.io/name"] == "prometheus" {
		return true
	}
	return false
}

func findPrometheusPort(svc corev1.Service) int {
	for _, p := range svc.Spec.Ports {
		if p.Port == 9090 {
			return 9090
		}
	}
	for _, p := range svc.Spec.Ports {
		if strings.EqualFold(p.Name, "http") || strings.EqualFold(p.Name, "web") {
			return int(p.Port)
		}
	}
	for _, p := range svc.Spec.Ports {
		if (p.Protocol == corev1.ProtocolTCP || p.Protocol == "") && p.Port >= 1024 {
			return int(p.Port)
		}
	}
	if len(svc.Spec.Ports) > 0 {
		return int(svc.Spec.Ports[0].Port)
	}
	return 9090
}

func (s *Server) discoverPrometheus(ctx context.Context, ctxName string) (*prometheusEndpoint, error) {
	// Check manual override in store first.
	if raw, ok := s.store.GetSecureValue(prometheusURLKey); ok && strings.TrimSpace(raw) != "" {
		return &prometheusEndpoint{Source: "manual", URL: strings.TrimSpace(raw)}, nil
	}

	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		return nil, nil // no client available — not an error
	}

	for _, ns := range prometheusNamespaces {
		svcList, err := cs.Clientset.CoreV1().Services(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			continue
		}
		for _, svc := range svcList.Items {
			if isPrometheusService(svc) {
				return &prometheusEndpoint{
					Namespace: ns,
					Service:   svc.Name,
					Port:      findPrometheusPort(svc),
					Source:    "autodiscovered",
				}, nil
			}
		}
	}
	return nil, nil
}

// proxyPrometheus proxies a request to Prometheus.
//
// For in-cluster endpoints (ep.URL == "") the request goes through the
// Kubernetes API-server proxy path and therefore uses the kube transport
// (which carries cluster credentials).
//
// For manual/external endpoints (ep.URL != "") a plain HTTP client is used
// so that cluster credentials are never forwarded to non-cluster hosts.
func proxyPrometheus(cfg *rest.Config, ep *prometheusEndpoint, apiPath string, query url.Values) ([]byte, error) {
	var (
		client    *http.Client
		targetURL string
	)

	if ep.URL != "" {
		// External/manual URL: plain client, no kube credentials attached.
		client = &http.Client{Timeout: 30 * time.Second}
		targetURL = strings.TrimRight(ep.URL, "/") + apiPath
		if len(query) > 0 {
			targetURL += "?" + query.Encode()
		}
	} else {
		// In-cluster via kube API-server proxy: kube transport required for auth.
		transport, err := rest.TransportFor(cfg)
		if err != nil {
			return nil, fmt.Errorf("creating transport: %w", err)
		}
		client = &http.Client{Transport: transport}
		base := strings.TrimRight(cfg.Host, "/")
		targetURL = fmt.Sprintf("%s/api/v1/namespaces/%s/services/http:%s:%d/proxy%s",
			base, ep.Namespace, ep.Service, ep.Port, apiPath)
		if len(query) > 0 {
			targetURL += "?" + query.Encode()
		}
	}

	resp, err := client.Get(targetURL) //nolint:noctx
	if err != nil {
		return nil, fmt.Errorf("proxying prometheus: %w", err)
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

func (s *Server) handleMetricsDiscover(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ctxName := s.resolveContext(r.URL.Query().Get("context"))
	ep, err := s.discoverPrometheus(r.Context(), ctxName)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if ep == nil {
		writeJSON(w, http.StatusOK, prometheusDiscoverResponse{Found: false})
		return
	}
	writeJSON(w, http.StatusOK, prometheusDiscoverResponse{Found: true, Endpoint: ep})
}

func (s *Server) handleMetricsQueryRange(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ctxName := s.resolveContext(r.URL.Query().Get("context"))
	// Re-discover endpoint server-side; never trust caller-supplied ep_* params.
	ep, err := s.discoverPrometheus(r.Context(), ctxName)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if ep == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "no Prometheus endpoint configured or discoverable"})
		return
	}
	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	q := url.Values{}
	for _, k := range []string{"query", "start", "end", "step"} {
		if v := r.URL.Query().Get(k); v != "" {
			q.Set(k, v)
		}
	}
	body, err := proxyPrometheus(cs.Config, ep, "/api/v1/query_range", q)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func (s *Server) handleMetricsQueryInstant(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ctxName := s.resolveContext(r.URL.Query().Get("context"))
	// Re-discover endpoint server-side; never trust caller-supplied ep_* params.
	ep, err := s.discoverPrometheus(r.Context(), ctxName)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if ep == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "no Prometheus endpoint configured or discoverable"})
		return
	}
	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	q := url.Values{}
	for _, k := range []string{"query", "time"} {
		if v := r.URL.Query().Get(k); v != "" {
			q.Set(k, v)
		}
	}
	body, err := proxyPrometheus(cs.Config, ep, "/api/v1/query", q)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func (s *Server) handleMetricsPrometheusURL(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	trimmed := strings.TrimSpace(body.URL)
	// Validate scheme: only http/https accepted.
	if trimmed != "" {
		parsed, err := url.Parse(trimmed)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "URL must use http or https scheme"})
			return
		}
	}
	if err := s.store.SetSecureValue(prometheusURLKey, trimmed); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
