package server

import (
	"encoding/json"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestIsAllowedExecOrigin(t *testing.T) {
	tests := []struct {
		name   string
		origin string
		want   bool
	}{
		{name: "empty", origin: "", want: true},
		{name: "null", origin: "null", want: true},
		{name: "file scheme", origin: "file:///tmp/index.html", want: true},
		{name: "localhost", origin: "http://localhost:3000", want: true},
		{name: "ipv4 loopback", origin: "http://127.0.0.1:8080", want: true},
		{name: "ipv6 loopback", origin: "http://[::1]:8080", want: true},
		{name: "remote host", origin: "https://example.com", want: false},
		{name: "invalid url", origin: "://bad", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isAllowedExecOrigin(tt.origin)
			if got != tt.want {
				t.Fatalf("isAllowedExecOrigin(%q) = %v, want %v", tt.origin, got, tt.want)
			}
		})
	}
}

func TestBuildContainerInfoStateMapping(t *testing.T) {
	start := metav1.NewTime(time.Date(2026, 2, 20, 12, 0, 0, 0, time.UTC))
	finish := metav1.NewTime(time.Date(2026, 2, 20, 12, 5, 0, 0, time.UTC))

	t.Run("running", func(t *testing.T) {
		info := buildContainerInfo("api", "img:v1", false, corev1.ContainerStatus{
			Ready:        true,
			RestartCount: 2,
			State: corev1.ContainerState{
				Running: &corev1.ContainerStateRunning{StartedAt: start},
			},
		})
		if info.State != "running" {
			t.Fatalf("state = %q, want running", info.State)
		}
		if info.StartedAt != "2026-02-20T12:00:00Z" {
			t.Fatalf("started_at = %q, want 2026-02-20T12:00:00Z", info.StartedAt)
		}
		if !info.Ready || info.RestartCount != 2 {
			t.Fatalf("ready/restarts mismatch: ready=%v restarts=%d", info.Ready, info.RestartCount)
		}
	})

	t.Run("waiting", func(t *testing.T) {
		info := buildContainerInfo("api", "img:v1", false, corev1.ContainerStatus{
			State: corev1.ContainerState{
				Waiting: &corev1.ContainerStateWaiting{
					Reason:  "ImagePullBackOff",
					Message: "pull failed",
				},
			},
		})
		if info.State != "waiting" || info.Reason != "ImagePullBackOff" || info.Message != "pull failed" {
			t.Fatalf("unexpected waiting info: state=%q reason=%q message=%q", info.State, info.Reason, info.Message)
		}
	})

	t.Run("terminated", func(t *testing.T) {
		info := buildContainerInfo("api", "img:v1", false, corev1.ContainerStatus{
			State: corev1.ContainerState{
				Terminated: &corev1.ContainerStateTerminated{
					Reason:     "Completed",
					Message:    "done",
					StartedAt:  start,
					FinishedAt: finish,
				},
			},
		})
		if info.State != "terminated" {
			t.Fatalf("state = %q, want terminated", info.State)
		}
		if info.Reason != "Completed" || info.Message != "done" {
			t.Fatalf("unexpected terminated info: reason=%q message=%q", info.Reason, info.Message)
		}
		if info.StartedAt != "2026-02-20T12:00:00Z" || info.FinishedAt != "2026-02-20T12:05:00Z" {
			t.Fatalf("unexpected timestamps: started=%q finished=%q", info.StartedAt, info.FinishedAt)
		}
	})
}

func TestComputeDiffUsesSemanticMergePatch(t *testing.T) {
	current := `
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  alpha: one
  beta: two
`
	proposed := `
kind: ConfigMap
apiVersion: v1
metadata:
  name: app-config
data:
  alpha: one
  beta: changed
  gamma: three
`

	diff := computeDiff(current, proposed)
	var patch map[string]any
	if err := json.Unmarshal([]byte(diff), &patch); err != nil {
		t.Fatalf("diff is not JSON merge patch: %v\n%s", err, diff)
	}
	data, ok := patch["data"].(map[string]any)
	if !ok {
		t.Fatalf("patch missing data object: %#v", patch)
	}
	if got := data["beta"]; got != "changed" {
		t.Fatalf("patch data.beta = %#v, want changed", got)
	}
	if got := data["gamma"]; got != "three" {
		t.Fatalf("patch data.gamma = %#v, want three", got)
	}
	if _, exists := patch["kind"]; exists {
		t.Fatalf("patch should not include unchanged key kind: %#v", patch["kind"])
	}
}

func TestParsePageToken(t *testing.T) {
	tests := []struct {
		name    string
		token   string
		want    int
		wantErr bool
	}{
		{name: "empty", token: "", want: 0},
		{name: "offset", token: "25", want: 25},
		{name: "trim", token: " 7 ", want: 7},
		{name: "negative", token: "-1", wantErr: true},
		{name: "invalid", token: "abc", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parsePageToken(tt.token)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error for token %q", tt.token)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Fatalf("got %d, want %d", got, tt.want)
			}
		})
	}
}

func TestResourceSortLessByNameAndNamespace(t *testing.T) {
	a := unstructured.Unstructured{}
	a.SetName("b-name")
	a.SetNamespace("ns-a")

	b := unstructured.Unstructured{}
	b.SetName("a-name")
	b.SetNamespace("ns-b")

	if !resourceSortLess(b, a, "name") {
		t.Fatalf("expected a-name < b-name for name sort")
	}
	if !resourceSortLess(a, b, "namespace") {
		t.Fatalf("expected ns-a < ns-b for namespace sort")
	}
}
