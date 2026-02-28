package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSearchInEntriesRankingAndFilters(t *testing.T) {
	entries := []searchIndexEntry{
		{Name: "api", Namespace: "ns1", Kind: "Pod", Group: "", Version: "v1", Resource: "pods"},
		{Name: "api-server", Namespace: "ns1", Kind: "Pod", Group: "", Version: "v1", Resource: "pods"},
		{Name: "my-api", Namespace: "ns2", Kind: "Pod", Group: "", Version: "v1", Resource: "pods"},
		{Name: "api", Namespace: "ns1", Kind: "Deployment", Group: "apps", Version: "v1", Resource: "deployments"},
	}

	t.Run("name ranking exact then prefix then contains", func(t *testing.T) {
		results := searchInEntries(entries, "api", "", 10)
		if len(results) < 3 {
			t.Fatalf("got %d results, want at least 3", len(results))
		}
		if results[0].Name != "api" {
			t.Fatalf("first result = %q, want exact match api", results[0].Name)
		}
	})

	t.Run("kind scoped query", func(t *testing.T) {
		results := searchInEntries(entries, "deploy api", "", 10)
		if len(results) != 1 {
			t.Fatalf("got %d results, want 1", len(results))
		}
		if results[0].Kind != "Deployment" || results[0].Resource != "deployments" {
			t.Fatalf("unexpected result: kind=%q resource=%q", results[0].Kind, results[0].Resource)
		}
	})

	t.Run("namespace filter and limit", func(t *testing.T) {
		results := searchInEntries(entries, "api", "ns1", 1)
		if len(results) != 1 {
			t.Fatalf("got %d results, want 1 due to limit", len(results))
		}
		if results[0].Namespace != "ns1" {
			t.Fatalf("namespace = %q, want ns1", results[0].Namespace)
		}
	})
}

func TestSearchIndexQueryUsesCachedEntries(t *testing.T) {
	s := &Server{
		searchIndexes: map[string]*searchIndexState{
			"ctx-a": {
				Entries: []searchIndexEntry{
					{Name: "api", Namespace: "ns1", Kind: "Pod", Group: "", Version: "v1", Resource: "pods"},
				},
				Building: false,
				BuiltAt:  time.Now(),
			},
		},
	}
	results, warming, ageMs := s.searchIndexQuery("ctx-a", "api", "ns1", 10)
	if warming {
		t.Fatalf("warming = true, want false")
	}
	if ageMs < 0 {
		t.Fatalf("index age = %d, want non-negative", ageMs)
	}
	if len(results) != 1 || results[0].Name != "api" {
		t.Fatalf("unexpected results: %+v", results)
	}
}

func TestHandleSearchResourcesEarlyResponses(t *testing.T) {
	s := &Server{searchIndexes: make(map[string]*searchIndexState)}

	t.Run("short query returns empty non-warming", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/search/resources?q=a&context=ctx", nil)
		rr := httptest.NewRecorder()
		s.handleSearchResources(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rr.Code)
		}
		var body struct {
			Results []searchResult `json:"results"`
			Warming bool           `json:"warming"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode json: %v", err)
		}
		if len(body.Results) != 0 || body.Warming {
			t.Fatalf("unexpected payload: %+v", body)
		}
	})

	t.Run("method not allowed", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/search/resources?q=api", nil)
		rr := httptest.NewRecorder()
		s.handleSearchResources(rr, req)
		if rr.Code != http.StatusMethodNotAllowed {
			t.Fatalf("status = %d, want 405", rr.Code)
		}
	})
}

func TestValidatePluginStorageRef(t *testing.T) {
	if err := validatePluginStorageRef("plugin.good-1", "group/key:1"); err != nil {
		t.Fatalf("unexpected error for valid refs: %v", err)
	}
	if err := validatePluginStorageRef("bad id", "k"); err == nil {
		t.Fatalf("expected error for invalid plugin id")
	}
	if err := validatePluginStorageRef("plugin", "bad key?"); err == nil {
		t.Fatalf("expected error for invalid key")
	}
}
