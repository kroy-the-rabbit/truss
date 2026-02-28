package discovery

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// ---------------------------------------------------------------------------
// categorize
// ---------------------------------------------------------------------------

func TestCategorizeKnownGroups(t *testing.T) {
	tests := []struct {
		group string
		kind  string
		want  string
	}{
		// Core group workloads
		{"", "Pod", "Workloads"},
		{"", "ReplicationController", "Workloads"},
		// Core group overrides
		{"", "ConfigMap", "Config"},
		{"", "Secret", "Config"},
		{"", "ServiceAccount", "Config"},
		{"", "Service", "Networking"},
		{"", "PersistentVolume", "Storage"},
		{"", "PersistentVolumeClaim", "Storage"},
		{"", "Namespace", "Cluster"},
		{"", "Node", "Cluster"},
		{"", "Event", "Cluster"},
		// Named groups
		{"apps", "Deployment", "Workloads"},
		{"batch", "Job", "Workloads"},
		{"networking.k8s.io", "Ingress", "Networking"},
		{"storage.k8s.io", "StorageClass", "Storage"},
		{"rbac.authorization.k8s.io", "Role", "RBAC"},
		{"policy", "PodDisruptionBudget", "RBAC"},
		{"autoscaling", "HorizontalPodAutoscaler", "Workloads"},
		// discovery.k8s.io override
		{"discovery.k8s.io", "EndpointSlice", "Networking"},
		{"events.k8s.io", "Event", "Cluster"},
		{"metrics.k8s.io", "NodeMetrics", "Cluster"},
		{"metrics.k8s.io", "PodMetrics", "Workloads"},
		// Custom (groups with dots not in map)
		{"example.io", "Widget", "Custom"},
		{"my.custom.domain", "MyResource", "Custom"},
		// Other (no dot, not in map)
		{"unknown", "Something", "Other"},
	}
	for _, tt := range tests {
		got := categorize(tt.group, tt.kind)
		if got != tt.want {
			t.Errorf("categorize(%q, %q) = %q, want %q", tt.group, tt.kind, got, tt.want)
		}
	}
}

// ---------------------------------------------------------------------------
// CategoryOrder
// ---------------------------------------------------------------------------

func TestCategoryOrder(t *testing.T) {
	tests := []struct {
		cat  string
		want int
	}{
		{"Workloads", 0},
		{"Config", 1},
		{"Networking", 2},
		{"Storage", 3},
		{"Cluster", 4},
		{"RBAC", 5},
		{"Custom", 6},
		{"Other", 7},
		{"Unknown", 99},
		{"", 99},
	}
	for _, tt := range tests {
		got := CategoryOrder(tt.cat)
		if got != tt.want {
			t.Errorf("CategoryOrder(%q) = %d, want %d", tt.cat, got, tt.want)
		}
	}
}

// Workloads sorts before Custom which sorts before Other.
func TestCategoryOrderOrdering(t *testing.T) {
	if CategoryOrder("Workloads") >= CategoryOrder("Custom") {
		t.Error("Workloads should have lower (better) order than Custom")
	}
	if CategoryOrder("Custom") >= CategoryOrder("Other") {
		t.Error("Custom should have lower order than Other")
	}
}

// ---------------------------------------------------------------------------
// kindOrder
// ---------------------------------------------------------------------------

func TestKindOrderKnownKinds(t *testing.T) {
	// Pod (priority 0) must sort before Deployment (1).
	if kindOrder("Pod") >= kindOrder("Deployment") {
		t.Error("Pod should have lower order than Deployment")
	}
	// Service (0) before Ingress (1).
	if kindOrder("Service") >= kindOrder("Ingress") {
		t.Error("Service should have lower order than Ingress")
	}
	// Namespace (0) before Node (1).
	if kindOrder("Namespace") >= kindOrder("Node") {
		t.Error("Namespace should have lower order than Node")
	}
}

func TestKindOrderUnknownKindReturnsFifty(t *testing.T) {
	got := kindOrder("MyUnknownKind")
	if got != 50 {
		t.Errorf("kindOrder(unknown) = %d, want 50", got)
	}
}

// ---------------------------------------------------------------------------
// IsNamespaced
// ---------------------------------------------------------------------------

func TestIsNamespacedFromCache(t *testing.T) {
	c := &Cache{
		cache: map[string][]ResourceInfo{
			"test-ctx": {
				{Group: "", Resource: "pods", Namespaced: true},
				{Group: "", Resource: "nodes", Namespaced: false},
				{Group: "apps", Resource: "deployments", Namespaced: true},
				{Group: "rbac.authorization.k8s.io", Resource: "clusterroles", Namespaced: false},
			},
		},
	}

	tests := []struct {
		group    string
		resource string
		want     bool
	}{
		{"", "pods", true},
		{"", "nodes", false},
		{"apps", "deployments", true},
		{"rbac.authorization.k8s.io", "clusterroles", false},
	}
	for _, tt := range tests {
		got := c.IsNamespaced("test-ctx", tt.group, tt.resource)
		if got != tt.want {
			t.Errorf("IsNamespaced(%q, %q, %q) = %v, want %v", "test-ctx", tt.group, tt.resource, got, tt.want)
		}
	}
}

func TestIsNamespacedUnknownContextDefaultsTrue(t *testing.T) {
	c := &Cache{cache: make(map[string][]ResourceInfo)}
	// Unknown context should default to true (safe for most operations).
	if !c.IsNamespaced("no-such-ctx", "", "pods") {
		t.Error("IsNamespaced for unknown context should default to true")
	}
}

func TestIsNamespacedUnknownResourceDefaultsTrue(t *testing.T) {
	c := &Cache{
		cache: map[string][]ResourceInfo{
			"ctx": {{Group: "", Resource: "pods", Namespaced: true}},
		},
	}
	// Unknown resource in a known context → true (safe default).
	if !c.IsNamespaced("ctx", "", "unknownresource") {
		t.Error("IsNamespaced for unknown resource should default to true")
	}
}

// ---------------------------------------------------------------------------
// Disk cache persistence
// ---------------------------------------------------------------------------

func TestSaveToDiskAndLoadFromDisk(t *testing.T) {
	tmp := t.TempDir()
	p := filepath.Join(tmp, "discovery-cache.json")

	c1 := &Cache{
		cache: map[string][]ResourceInfo{
			"my-ctx": {
				{Kind: "Pod", Group: "", Version: "v1", Resource: "pods", Namespaced: true, Category: "Workloads"},
				{Kind: "Node", Group: "", Version: "v1", Resource: "nodes", Namespaced: false, Category: "Cluster"},
			},
		},
		persistPath: p,
	}
	c1.saveToDisk()

	// File must exist.
	if _, err := os.Stat(p); err != nil {
		t.Fatalf("expected cache file at %s: %v", p, err)
	}

	// Verify version in the file.
	b, _ := os.ReadFile(p)
	var dc diskCache
	if err := json.Unmarshal(b, &dc); err != nil {
		t.Fatalf("cache file is invalid JSON: %v", err)
	}
	if dc.Version != 2 {
		t.Errorf("disk cache version = %d, want 2", dc.Version)
	}
	if len(dc.Contexts["my-ctx"]) != 2 {
		t.Errorf("expected 2 resources for my-ctx, got %d", len(dc.Contexts["my-ctx"]))
	}

	// Load into a new cache and verify data is restored.
	c2 := &Cache{
		cache:       make(map[string][]ResourceInfo),
		persistPath: p,
	}
	c2.loadFromDisk()

	resources := c2.cache["my-ctx"]
	if len(resources) != 2 {
		t.Fatalf("loaded cache has %d resources, want 2", len(resources))
	}
	if resources[0].Kind != "Pod" {
		t.Errorf("first resource kind = %q, want Pod", resources[0].Kind)
	}
}

func TestLoadFromDiskRejectsOldVersion(t *testing.T) {
	tmp := t.TempDir()
	p := filepath.Join(tmp, "old-cache.json")

	// Write a version-1 cache (should be rejected).
	old := diskCache{Version: 1, Contexts: map[string][]ResourceInfo{"ctx": {{Kind: "Pod"}}}}
	b, _ := json.Marshal(old)
	os.WriteFile(p, b, 0o600)

	c := &Cache{cache: make(map[string][]ResourceInfo), persistPath: p}
	c.loadFromDisk()

	if _, ok := c.cache["ctx"]; ok {
		t.Error("version-1 cache should be rejected and not loaded")
	}
}

func TestLoadFromDiskIgnoresMissingFile(t *testing.T) {
	c := &Cache{
		cache:       make(map[string][]ResourceInfo),
		persistPath: "/nonexistent/path/cache.json",
	}
	// Must not panic or return error.
	c.loadFromDisk()
	if len(c.cache) != 0 {
		t.Error("expected empty cache when file is missing")
	}
}
