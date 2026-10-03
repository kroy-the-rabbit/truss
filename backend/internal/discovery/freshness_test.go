package discovery

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/discovery/fake"
	ktesting "k8s.io/client-go/testing"
)

// stubDiscovery serves a fixed preferred-resources list and counts calls.
type stubDiscovery struct {
	*fake.FakeDiscovery
	lists []*metav1.APIResourceList
	err   error
	calls int
}

func (d *stubDiscovery) ServerPreferredResources() ([]*metav1.APIResourceList, error) {
	d.calls++
	if d.err != nil {
		return nil, d.err
	}
	return d.lists, nil
}

func newStub() *stubDiscovery {
	return &stubDiscovery{
		FakeDiscovery: &fake.FakeDiscovery{Fake: &ktesting.Fake{}},
		lists: []*metav1.APIResourceList{
			{GroupVersion: "v1", APIResources: []metav1.APIResource{
				{Name: "pods", Kind: "Pod", Namespaced: true, Verbs: []string{"get", "list", "watch"}},
			}},
			{GroupVersion: "metrics.k8s.io/v1beta1", APIResources: []metav1.APIResource{
				{Name: "pods", Kind: "PodMetrics", Namespaced: true, Verbs: []string{"get", "list"}},
			}},
			{GroupVersion: "authentication.k8s.io/v1", APIResources: []metav1.APIResource{
				{Name: "tokenreviews", Kind: "TokenReview", Verbs: []string{"create"}},
			}},
		},
	}
}

func newTestCache(now *time.Time) *Cache {
	return &Cache{cache: map[string][]ResourceInfo{}, fetched: map[string]time.Time{}, now: func() time.Time { return *now }}
}

func TestDiscoverSkipsUnlistableAndRecordsVerbs(t *testing.T) {
	now := time.Now()
	c := newTestCache(&now)
	got, err := c.Discover("ctx", newStub(), false)
	if err != nil {
		t.Fatal(err)
	}
	byKind := map[string]ResourceInfo{}
	for _, r := range got {
		byKind[r.Kind] = r
	}
	if _, ok := byKind["TokenReview"]; ok {
		t.Error("TokenReview has no list verb and must be skipped")
	}
	if !byKind["Pod"].Watchable() {
		t.Error("Pod should be watchable")
	}
	pm, ok := byKind["PodMetrics"]
	if !ok {
		t.Fatal("PodMetrics is listable and should be discovered")
	}
	if pm.Watchable() {
		t.Error("PodMetrics has no watch verb and must not be watchable")
	}
}

func TestWatchableTreatsUnknownVerbsAsWatchable(t *testing.T) {
	if !(ResourceInfo{Kind: "ConfigMap"}).Watchable() {
		t.Error("nil Verbs should be treated as watchable")
	}
}

func TestDiscoverRefetchesAfterTTL(t *testing.T) {
	now := time.Now()
	c := newTestCache(&now)
	d := newStub()
	if _, err := c.Discover("ctx", d, false); err != nil {
		t.Fatal(err)
	}
	now = now.Add(cacheTTL - time.Minute)
	if _, err := c.Discover("ctx", d, false); err != nil {
		t.Fatal(err)
	}
	if d.calls != 1 {
		t.Fatalf("calls within TTL = %d, want 1", d.calls)
	}
	now = now.Add(2 * time.Minute)
	if _, err := c.Discover("ctx", d, false); err != nil {
		t.Fatal(err)
	}
	if d.calls != 2 {
		t.Fatalf("calls after TTL = %d, want 2", d.calls)
	}
}

func TestDiscoverServesStaleResultWhenRefreshFails(t *testing.T) {
	now := time.Now()
	c := newTestCache(&now)
	d := newStub()
	first, err := c.Discover("ctx", d, false)
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(cacheTTL + time.Hour)
	d.err = errors.New("connection refused")
	got, err := c.Discover("ctx", d, false)
	if err != nil {
		t.Fatalf("stale result should be served, got error %v", err)
	}
	if len(got) != len(first) {
		t.Fatalf("stale result len = %d, want %d", len(got), len(first))
	}
	// A forced refresh must surface the error instead.
	if _, err := c.Discover("ctx", d, true); err == nil {
		t.Fatal("forced refresh should return the discovery error")
	}
}

func TestLoadFromDiskRejectsVersion2(t *testing.T) {
	p := filepath.Join(t.TempDir(), "cache.json")
	b, _ := json.Marshal(diskCache{Version: 2, Contexts: map[string][]ResourceInfo{"ctx": {{Kind: "Pod"}}}})
	if err := os.WriteFile(p, b, 0o600); err != nil {
		t.Fatal(err)
	}
	c := &Cache{cache: map[string][]ResourceInfo{}, persistPath: p}
	c.loadFromDisk()
	if _, ok := c.cache["ctx"]; ok {
		t.Error("version-2 cache (no verbs, never expires) must be rejected")
	}
}

func TestSaveAndLoadKeepsFetchTimes(t *testing.T) {
	p := filepath.Join(t.TempDir(), "cache.json")
	now := time.Now().Truncate(time.Second)
	c := newTestCache(&now)
	c.persistPath = p
	if _, err := c.Discover("ctx", newStub(), false); err != nil {
		t.Fatal(err)
	}
	c2 := &Cache{cache: map[string][]ResourceInfo{}, persistPath: p}
	c2.loadFromDisk()
	if got := c2.fetched["ctx"]; !got.Equal(now) {
		t.Fatalf("fetched = %v, want %v", got, now)
	}
	if v := c2.cache["ctx"][0].Verbs; len(v) == 0 {
		t.Fatal("verbs not persisted")
	}
}
