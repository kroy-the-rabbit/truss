package server

import (
	"context"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

type searchIndexEntry struct {
	Name      string
	Namespace string
	Kind      string
	Group     string
	Version   string
	Resource  string
}

type searchIndexState struct {
	Entries  []searchIndexEntry
	Building bool
	BuiltAt  time.Time
}

type searchResult struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Kind      string `json:"kind"`
	Group     string `json:"group"`
	Version   string `json:"version"`
	Resource  string `json:"resource"`
}

type scoredSearchResult struct {
	result searchResult
	score  int
}

const searchIndexRefreshInterval = 15 * time.Second

func (s *Server) handleSearchResources(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(q) < 2 {
		writeJSON(w, http.StatusOK, map[string]any{
			"results":      []searchResult{},
			"warming":      false,
			"index_age_ms": int64(0),
		})
		return
	}

	ctxName := s.resolveContext(r.URL.Query().Get("context"))
	if ctxName == "" {
		writeJSON(w, http.StatusOK, map[string]any{
			"results":      []searchResult{},
			"warming":      false,
			"index_age_ms": int64(0),
		})
		return
	}

	namespace := strings.TrimSpace(r.URL.Query().Get("namespace"))
	limit := 200
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			if parsed > 1000 {
				parsed = 1000
			}
			limit = parsed
		}
	}

	results, warming, ageMs := s.searchIndexQuery(ctxName, q, namespace, limit)
	writeJSON(w, http.StatusOK, map[string]any{
		"results":      results,
		"warming":      warming,
		"index_age_ms": ageMs,
	})
}

func (s *Server) searchIndexQuery(contextName, query, namespace string, limit int) ([]searchResult, bool, int64) {
	now := time.Now()

	s.searchMu.RLock()
	state := s.searchIndexes[contextName]
	if state == nil {
		s.searchMu.RUnlock()
		s.triggerSearchIndexRefresh(contextName)
		return []searchResult{}, true, 0
	}
	entries := state.Entries
	building := state.Building
	builtAt := state.BuiltAt
	s.searchMu.RUnlock()

	age := now.Sub(builtAt)
	if builtAt.IsZero() || age > searchIndexRefreshInterval {
		s.triggerSearchIndexRefresh(contextName)
	}

	if len(entries) == 0 {
		return []searchResult{}, building, int64(age / time.Millisecond)
	}

	results := searchInEntries(entries, query, namespace, limit)
	return results, building, int64(age / time.Millisecond)
}

func (s *Server) triggerSearchIndexRefresh(contextName string) {
	if contextName == "" {
		return
	}

	s.searchMu.Lock()
	state, ok := s.searchIndexes[contextName]
	if !ok {
		state = &searchIndexState{}
		s.searchIndexes[contextName] = state
	}
	if state.Building {
		s.searchMu.Unlock()
		return
	}
	state.Building = true
	s.searchMu.Unlock()

	go func() {
		entries := s.buildSearchIndex(contextName)
		s.searchMu.Lock()
		defer s.searchMu.Unlock()
		st, ok := s.searchIndexes[contextName]
		if !ok {
			st = &searchIndexState{}
			s.searchIndexes[contextName] = st
		}
		if entries != nil {
			st.Entries = entries
			st.BuiltAt = time.Now()
		}
		st.Building = false
	}()
}

func (s *Server) buildSearchIndex(contextName string) []searchIndexEntry {
	cs, err := s.kubeMgr.GetClientSet(contextName)
	if err != nil {
		return nil
	}

	resources, err := s.discoveryCache.Discover(contextName, cs.Discovery, false)
	if err != nil {
		return nil
	}

	// Ensure informers are running (idempotent).
	s.watchCache.EnsureStarted(contextName, cs.Dynamic, resources)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	entries := make([]searchIndexEntry, 0, 4096)
	for _, r := range resources {
		gvr := schema.GroupVersionResource{Group: r.Group, Version: r.Version, Resource: r.Resource}

		// Hot path: serve from the in-memory cache with zero API calls.
		if items, synced := s.watchCache.ListAll(contextName, gvr, ""); synced {
			for _, item := range items {
				if item.GetName() == "" {
					continue
				}
				entries = append(entries, searchIndexEntry{
					Name:      item.GetName(),
					Namespace: item.GetNamespace(),
					Kind:      r.Kind,
					Group:     r.Group,
					Version:   r.Version,
					Resource:  r.Resource,
				})
			}
			continue
		}

		// Cold path: fall back to a direct List for this GVR while cache warms.
		list, listErr := cs.Dynamic.Resource(gvr).List(ctx, metav1.ListOptions{})
		if listErr != nil {
			continue
		}
		for _, item := range list.Items {
			if item.GetName() == "" {
				continue
			}
			entries = append(entries, searchIndexEntry{
				Name:      item.GetName(),
				Namespace: item.GetNamespace(),
				Kind:      r.Kind,
				Group:     r.Group,
				Version:   r.Version,
				Resource:  r.Resource,
			})
		}
	}

	return entries
}

func searchInEntries(entries []searchIndexEntry, query, namespace string, limit int) []searchResult {
	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		return []searchResult{}
	}

	tokens := strings.Fields(q)
	nameFilter := q
	kindFilter := ""
	if len(tokens) > 1 {
		kindFilter = tokens[0]
		nameFilter = strings.Join(tokens[1:], " ")
	}

	scored := make([]scoredSearchResult, 0, min(limit*4, len(entries)))
	for _, e := range entries {
		if namespace != "" && e.Namespace != namespace {
			continue
		}
		nameLower := strings.ToLower(e.Name)
		kindLower := strings.ToLower(e.Kind)
		resourceLower := strings.ToLower(e.Resource)
		groupLower := strings.ToLower(e.Group)

		if kindFilter != "" {
			kindText := kindLower + " " + resourceLower + " " + groupLower
			if !strings.Contains(kindText, kindFilter) {
				continue
			}
		}

		if !strings.Contains(nameLower, nameFilter) {
			continue
		}

		score := 10
		switch {
		case nameLower == nameFilter:
			score = 0
		case strings.HasPrefix(nameLower, nameFilter):
			score = 1
		case strings.Contains(nameLower, nameFilter):
			score = 2
		}
		if kindFilter != "" && strings.Contains(kindLower, kindFilter) {
			score -= 1
		}

		scored = append(scored, scoredSearchResult{
			result: searchResult{
				Name:      e.Name,
				Namespace: e.Namespace,
				Kind:      e.Kind,
				Group:     e.Group,
				Version:   e.Version,
				Resource:  e.Resource,
			},
			score: score,
		})
	}

	sort.Slice(scored, func(i, j int) bool {
		if scored[i].score != scored[j].score {
			return scored[i].score < scored[j].score
		}
		if scored[i].result.Name != scored[j].result.Name {
			return scored[i].result.Name < scored[j].result.Name
		}
		if scored[i].result.Kind != scored[j].result.Kind {
			return scored[i].result.Kind < scored[j].result.Kind
		}
		return scored[i].result.Namespace < scored[j].result.Namespace
	})

	if len(scored) > limit {
		scored = scored[:limit]
	}

	out := make([]searchResult, 0, len(scored))
	for _, item := range scored {
		out = append(out, item.result)
	}
	return out
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
