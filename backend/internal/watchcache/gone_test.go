package watchcache

import (
	"sync/atomic"
	"testing"
	"time"

	disc "github.com/kroy/truss/backend/internal/discovery"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynfake "k8s.io/client-go/dynamic/fake"
	ktesting "k8s.io/client-go/testing"
)

func TestEnsureStartedSkipsUnwatchableResources(t *testing.T) {
	gvr := schema.GroupVersionResource{Group: "metrics.k8s.io", Version: "v1beta1", Resource: "pods"}
	client := dynfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{gvr: "PodMetricsList"})
	m := New()
	defer m.StopAll()
	m.EnsureStarted("ctx", client, []disc.ResourceInfo{{
		Group: gvr.Group, Version: gvr.Version, Resource: gvr.Resource, Kind: "PodMetrics",
		Namespaced: true, Verbs: []string{"get", "list"},
	}})
	if m.HasGVR("ctx", gvr) {
		t.Fatal("a resource without the watch verb must not get an informer")
	}
}

func TestResourceGoneReportedOnceAndNotAsContextError(t *testing.T) {
	gvr := schema.GroupVersionResource{Group: "tekton.dev", Version: "v1alpha1", Resource: "runs"}
	client := dynfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{gvr: "RunList"})
	client.PrependReactor("list", "runs", func(ktesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewNotFound(gvr.GroupResource(), "")
	})

	m := New()
	defer m.StopAll()
	var gone, contextErrors atomic.Int32
	got := make(chan schema.GroupVersionResource, 4)
	m.SetHealthHooks(nil, func(string, error) { contextErrors.Add(1) })
	m.SetResourceGoneHandler(func(ctx string, g schema.GroupVersionResource) {
		gone.Add(1)
		got <- g
	})
	m.EnsureStarted("ctx", client, []disc.ResourceInfo{{
		Group: gvr.Group, Version: gvr.Version, Resource: gvr.Resource, Kind: "Run",
		Namespaced: true, Verbs: []string{"get", "list", "watch"},
	}})

	select {
	case g := <-got:
		if g != gvr {
			t.Fatalf("gone gvr = %v, want %v", g, gvr)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("resource-gone handler was not called")
	}
	// Let the reflector retry a few times; the handler must not fire again.
	time.Sleep(1500 * time.Millisecond)
	if n := gone.Load(); n != 1 {
		t.Fatalf("gone handler calls = %d, want 1", n)
	}
	if n := contextErrors.Load(); n != 0 {
		t.Fatalf("a missing resource must not be reported as a context error (got %d)", n)
	}
}
