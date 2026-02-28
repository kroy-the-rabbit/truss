package discovery

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"
)

// ResourceInfo holds information about a Kubernetes resource kind.
type ResourceInfo struct {
	Kind       string
	Group      string
	Version    string
	Resource   string // plural name
	Namespaced bool
	Category   string
}

// Cache caches API discovery results per context.
type Cache struct {
	mu          sync.RWMutex
	cache       map[string][]ResourceInfo
	persistPath string
}

// NewCache creates a new discovery cache.
func NewCache() *Cache {
	c := &Cache{cache: make(map[string][]ResourceInfo)}
	if p, err := defaultCachePath(); err == nil {
		c.persistPath = p
		c.loadFromDisk()
	}
	return c
}

type diskCache struct {
	Version   int                       `json:"version"`
	UpdatedAt string                    `json:"updated_at,omitempty"`
	Contexts  map[string][]ResourceInfo `json:"contexts"`
}

// categoryMap maps API groups to UI categories.
var categoryMap = map[string]string{
	"":                             "Workloads",
	"apps":                         "Workloads",
	"batch":                        "Workloads",
	"networking.k8s.io":            "Networking",
	"extensions":                   "Networking",
	"storage.k8s.io":               "Storage",
	"rbac.authorization.k8s.io":    "RBAC",
	"policy":                       "RBAC",
	"admissionregistration.k8s.io": "Config",
	"autoscaling":                  "Workloads",
}

// kindOverrides maps "group/Kind" to a UI category for specific resources
// that would otherwise be miscategorized by their API group alone.
var kindOverrides = map[string]string{
	// Core group resources that aren't "Workloads"
	"/ConfigMap":             "Config",
	"/Secret":                "Config",
	"/ServiceAccount":        "Config",
	"/LimitRange":            "Config",
	"/ResourceQuota":         "Config",
	"/Service":               "Networking",
	"/Endpoints":             "Networking",
	"/PersistentVolume":      "Storage",
	"/PersistentVolumeClaim": "Storage",
	"/Namespace":             "Cluster",
	"/Node":                  "Cluster",
	"/Event":                 "Cluster",
	// Non-core resources
	"discovery.k8s.io/EndpointSlice": "Networking",
	"events.k8s.io/Event":            "Cluster",
	"metrics.k8s.io/NodeMetrics":     "Cluster",
	"metrics.k8s.io/PodMetrics":      "Workloads",
}

func categorize(group, kind string) string {
	key := group + "/" + kind
	if cat, ok := kindOverrides[key]; ok {
		return cat
	}
	if cat, ok := categoryMap[group]; ok {
		return cat
	}
	if strings.Contains(group, ".") {
		return "Custom"
	}
	return "Other"
}

// categoryPriority controls the display order of resource groups in the tree.
// Lower number = higher in the list.
var categoryPriority = map[string]int{
	"Workloads":  0,
	"Config":     1,
	"Networking": 2,
	"Storage":    3,
	"Cluster":    4,
	"RBAC":       5,
	"Custom":     6,
	"Other":      7,
}

func CategoryOrder(cat string) int {
	if p, ok := categoryPriority[cat]; ok {
		return p
	}
	return 99
}

// kindPriority controls the display order within a category.
// Frequently used kinds sort first; unlisted kinds sort alphabetically after.
var kindPriority = map[string]int{
	// Workloads
	"Pod":         0,
	"Deployment":  1,
	"StatefulSet": 2,
	"DaemonSet":   3,
	"Job":         4,
	"CronJob":     5,
	"ReplicaSet":  6,
	// Config
	"ConfigMap":      0,
	"Secret":         1,
	"ServiceAccount": 2,
	// Networking
	"Service":       0,
	"Ingress":       1,
	"NetworkPolicy": 2,
	"EndpointSlice": 3,
	// Storage
	"PersistentVolumeClaim": 0,
	"PersistentVolume":      1,
	"StorageClass":          2,
	// Cluster
	"Namespace": 0,
	"Node":      1,
	"Event":     2,
}

func kindOrder(kind string) int {
	if p, ok := kindPriority[kind]; ok {
		return p
	}
	return 50
}

// deprecatedResourceNames are skipped from discovery results to avoid surfacing
// deprecated APIs in the UI and periodic count polling.
var deprecatedResourceNames = map[string]bool{
	"componentstatuses": true, // core/v1 ComponentStatus (deprecated)
	"endpoints":         true, // core/v1 Endpoints (deprecated in favor of EndpointSlice)
}

// Discover fetches resource kinds from a cluster using API discovery.
func (c *Cache) Discover(contextName string, disc discovery.DiscoveryInterface, force bool) ([]ResourceInfo, error) {
	if !force {
		c.mu.RLock()
		if cached, ok := c.cache[contextName]; ok {
			c.mu.RUnlock()
			return cached, nil
		}
		c.mu.RUnlock()
	}

	// ServerPreferredResources returns only the server's preferred (highest stable)
	// version for each resource kind — no deprecated v1beta1 duplicates.
	apiResourceLists, err := disc.ServerPreferredResources()
	if err != nil {
		// Partial results are OK — some groups may fail (e.g. metrics-server absent).
		if apiResourceLists == nil {
			return nil, err
		}
	}

	var allResources []ResourceInfo
	seen := make(map[string]bool)
	kindInCategory := make(map[string]bool) // "category/Kind" dedup

	for _, list := range apiResourceLists {
		gv, parseErr := schema.ParseGroupVersion(list.GroupVersion)
		if parseErr != nil {
			continue
		}
		for _, r := range list.APIResources {
			// Skip sub-resources like pods/log, pods/status.
			if strings.Contains(r.Name, "/") {
				continue
			}
			// Skip deprecated API resources.
			if deprecatedResourceNames[strings.ToLower(r.Name)] {
				continue
			}
			// Skip resources with empty Kind.
			if r.Kind == "" {
				continue
			}
			key := gv.Group + "/" + r.Kind
			if seen[key] {
				continue
			}
			seen[key] = true

			cat := categorize(gv.Group, r.Kind)

			// Dedup within the same category across API groups.
			catKindKey := cat + "/" + r.Kind
			if kindInCategory[catKindKey] {
				continue
			}
			kindInCategory[catKindKey] = true

			allResources = append(allResources, ResourceInfo{
				Kind:       r.Kind,
				Group:      gv.Group,
				Version:    gv.Version,
				Resource:   r.Name,
				Namespaced: r.Namespaced,
				Category:   cat,
			})
		}
	}

	// Second pass: remove from Custom/Other any Kind that also exists
	// in a well-known category (avoids duplicate Service, Ingress, Node, etc.).
	wellKnownKinds := make(map[string]bool)
	for _, r := range allResources {
		if r.Category != "Custom" && r.Category != "Other" {
			wellKnownKinds[r.Kind] = true
		}
	}
	var resources []ResourceInfo
	for _, r := range allResources {
		if (r.Category == "Custom" || r.Category == "Other") && wellKnownKinds[r.Kind] {
			continue
		}
		resources = append(resources, r)
	}

	sort.Slice(resources, func(i, j int) bool {
		ci := CategoryOrder(resources[i].Category)
		cj := CategoryOrder(resources[j].Category)
		if ci != cj {
			return ci < cj
		}
		ki := kindOrder(resources[i].Kind)
		kj := kindOrder(resources[j].Kind)
		if ki != kj {
			return ki < kj
		}
		return resources[i].Kind < resources[j].Kind
	})

	c.mu.Lock()
	c.cache[contextName] = resources
	c.mu.Unlock()
	c.saveToDisk()

	return resources, nil
}

// IsNamespaced returns whether the given resource (by plural name) in the given context
// is namespace-scoped. Returns true if unknown (safe default for most operations).
func (c *Cache) IsNamespaced(contextName, group, resource string) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	cached, ok := c.cache[contextName]
	if !ok {
		return true
	}
	for _, r := range cached {
		if r.Resource == resource && r.Group == group {
			return r.Namespaced
		}
	}
	return true
}

func defaultCachePath() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(configDir, "truss", "discovery-cache.json"), nil
}

func (c *Cache) loadFromDisk() {
	if c.persistPath == "" {
		return
	}
	b, err := os.ReadFile(c.persistPath)
	if err != nil {
		return
	}
	var dc diskCache
	// Version 2: switched to ServerPreferredResources — reject older caches so
	// deprecated API versions are not served from stale disk state.
	if err := json.Unmarshal(b, &dc); err != nil || dc.Contexts == nil || dc.Version < 2 {
		return
	}
	c.mu.Lock()
	c.cache = dc.Contexts
	c.mu.Unlock()
}

func (c *Cache) saveToDisk() {
	if c.persistPath == "" {
		return
	}
	c.mu.RLock()
	snapshot := make(map[string][]ResourceInfo, len(c.cache))
	for k, v := range c.cache {
		cp := make([]ResourceInfo, len(v))
		copy(cp, v)
		snapshot[k] = cp
	}
	c.mu.RUnlock()

	if err := os.MkdirAll(filepath.Dir(c.persistPath), 0o700); err != nil {
		return
	}
	payload, err := json.Marshal(diskCache{
		Version:   2,
		UpdatedAt: time.Now().UTC().Format(time.RFC3339),
		Contexts:  snapshot,
	})
	if err != nil {
		return
	}
	_ = os.WriteFile(c.persistPath, payload, 0o600)
}
