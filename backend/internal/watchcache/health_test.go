package watchcache

import (
	"sync/atomic"
	"testing"
	"time"

	disc "github.com/kroy/truss/backend/internal/discovery"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynfake "k8s.io/client-go/dynamic/fake"
)

func TestListAllReportsUnsyncedWhileContextUnhealthy(t *testing.T) {
	gvr := schema.GroupVersionResource{Version: "v1", Resource: "configmaps"}
	cm := &unstructured.Unstructured{}
	cm.SetAPIVersion("v1")
	cm.SetKind("ConfigMap")
	cm.SetName("a")
	cm.SetNamespace("default")
	client := dynfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{gvr: "ConfigMapList"}, cm)

	m := New()
	defer m.StopAll()
	var unhealthy atomic.Bool
	m.SetHealthHooks(func(string) bool { return unhealthy.Load() }, nil)
	m.EnsureStarted("ctx", client, []disc.ResourceInfo{{Version: "v1", Resource: "configmaps", Kind: "ConfigMap", Namespaced: true}})

	deadline := time.Now().Add(5 * time.Second)
	for {
		if items, synced := m.ListAll("ctx", gvr, ""); synced {
			if len(items) != 1 {
				t.Fatalf("items = %d, want 1", len(items))
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("cache never synced")
		}
		time.Sleep(10 * time.Millisecond)
	}

	unhealthy.Store(true)
	if _, synced := m.ListAll("ctx", gvr, ""); synced {
		t.Fatal("ListAll must report synced=false while context is unhealthy")
	}
	if _, synced := m.Len("ctx", gvr, ""); synced {
		t.Fatal("Len must report synced=false while context is unhealthy")
	}
	unhealthy.Store(false)
	if _, synced := m.ListAll("ctx", gvr, ""); !synced {
		t.Fatal("ListAll should be synced again once healthy")
	}
}
