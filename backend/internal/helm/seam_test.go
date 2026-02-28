package helm

import (
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"helm.sh/helm/v3/pkg/action"
	"helm.sh/helm/v3/pkg/chart"
	"helm.sh/helm/v3/pkg/chartutil"
	kubefake "helm.sh/helm/v3/pkg/kube/fake"
	"helm.sh/helm/v3/pkg/registry"
	"helm.sh/helm/v3/pkg/release"
	helmtime "helm.sh/helm/v3/pkg/time"
	"helm.sh/helm/v3/pkg/storage"
	"helm.sh/helm/v3/pkg/storage/driver"
	"k8s.io/client-go/rest"
)

// testActionConfig creates an in-memory action.Configuration suitable for unit tests.
// No live Kubernetes cluster is needed.
func testActionConfig(t *testing.T) *action.Configuration {
	t.Helper()
	reg, err := registry.NewClient()
	if err != nil {
		t.Fatalf("registry.NewClient: %v", err)
	}
	return &action.Configuration{
		Releases:       storage.Init(driver.NewMemory()),
		KubeClient:     &kubefake.FailingKubeClient{PrintingKubeClient: kubefake.PrintingKubeClient{Out: io.Discard}},
		Capabilities:   chartutil.DefaultCapabilities,
		RegistryClient: reg,
		Log:            func(format string, v ...interface{}) {},
	}
}

// withFakeActionConfig replaces newActionConfigFn for the duration of the test.
func withFakeActionConfig(t *testing.T, ac *action.Configuration) {
	t.Helper()
	orig := newActionConfigFn
	newActionConfigFn = func(_ *rest.Config, _ string) (*action.Configuration, error) {
		return ac, nil
	}
	t.Cleanup(func() { newActionConfigFn = orig })
}

// testRelease builds a minimal *release.Release for insertion into the in-memory store.
func testReleaseStub(name, ns string, rev int, status release.Status, chartName, chartVer string, deployed time.Time) *release.Release {
	rel := &release.Release{
		Name:      name,
		Namespace: ns,
		Version:   rev,
		Info: &release.Info{
			Status:       status,
			LastDeployed: helmtime.Time{Time: deployed},
		},
		Chart: &chart.Chart{
			Metadata: &chart.Metadata{
				Name:    chartName,
				Version: chartVer,
			},
		},
	}
	return rel
}

// dummyCfg is a placeholder rest.Config; it is never used when newActionConfigFn is faked.
var dummyCfg = &rest.Config{Host: "https://localhost:6443"}

// ---------------------------------------------------------------------------
// ListReleases
// ---------------------------------------------------------------------------

func TestListReleasesEmpty(t *testing.T) {
	ac := testActionConfig(t)
	withFakeActionConfig(t, ac)

	releases, err := ListReleases(dummyCfg, "default")
	if err != nil {
		t.Fatalf("ListReleases: %v", err)
	}
	if len(releases) != 0 {
		t.Errorf("expected 0 releases, got %d", len(releases))
	}
}

func TestListReleasesSorted(t *testing.T) {
	// The in-memory Helm driver stores releases in a single namespace bucket.
	// Use "default" for all releases so the driver's namespace filter is consistent.
	ac := testActionConfig(t)
	deployed := time.Date(2026, 2, 24, 0, 0, 0, 0, time.UTC)
	for _, name := range []string{"z-app", "a-app", "m-app"} {
		if err := ac.Releases.Create(testReleaseStub(name, "default", 1, release.StatusDeployed, name+"-chart", "1.0.0", deployed)); err != nil {
			t.Fatalf("Create %s: %v", name, err)
		}
	}
	withFakeActionConfig(t, ac)

	releases, err := ListReleases(dummyCfg, "default")
	if err != nil {
		t.Fatalf("ListReleases: %v", err)
	}
	if len(releases) != 3 {
		t.Fatalf("expected 3 releases, got %d", len(releases))
	}
	// Sorted by name within namespace.
	if releases[0].Name != "a-app" {
		t.Errorf("releases[0].Name = %q, want a-app", releases[0].Name)
	}
	if releases[1].Name != "m-app" {
		t.Errorf("releases[1].Name = %q, want m-app", releases[1].Name)
	}
	if releases[2].Name != "z-app" {
		t.Errorf("releases[2].Name = %q, want z-app", releases[2].Name)
	}
}

func TestListReleasesAllNamespacesFlag(t *testing.T) {
	// Verify the AllNamespaces path (namespace == "") does not error.
	ac := testActionConfig(t)
	deployed := time.Date(2026, 2, 24, 0, 0, 0, 0, time.UTC)
	if err := ac.Releases.Create(testReleaseStub("app", "default", 1, release.StatusDeployed, "chart", "1.0.0", deployed)); err != nil {
		t.Fatalf("Create: %v", err)
	}
	withFakeActionConfig(t, ac)

	releases, err := ListReleases(dummyCfg, "") // AllNamespaces = true
	if err != nil {
		t.Fatalf("ListReleases(AllNamespaces): %v", err)
	}
	if len(releases) == 0 {
		t.Error("expected at least one release with AllNamespaces=true")
	}
}

// ---------------------------------------------------------------------------
// GetRelease
// ---------------------------------------------------------------------------

func TestGetReleaseNotFound(t *testing.T) {
	ac := testActionConfig(t)
	withFakeActionConfig(t, ac)

	_, err := GetRelease(dummyCfg, "default", "no-such-release")
	if err == nil {
		t.Fatal("GetRelease should return error for unknown release")
	}
}

func TestGetReleaseFound(t *testing.T) {
	ac := testActionConfig(t)
	deployed := time.Date(2026, 2, 24, 12, 0, 0, 0, time.UTC)
	if err := ac.Releases.Create(testReleaseStub("my-app", "production", 3, release.StatusDeployed, "my-chart", "1.2.3", deployed)); err != nil {
		t.Fatalf("Create: %v", err)
	}
	withFakeActionConfig(t, ac)

	rel, err := GetRelease(dummyCfg, "production", "my-app")
	if err != nil {
		t.Fatalf("GetRelease: %v", err)
	}
	if rel.Name != "my-app" {
		t.Errorf("Name = %q, want my-app", rel.Name)
	}
	if rel.Namespace != "production" {
		t.Errorf("Namespace = %q, want production", rel.Namespace)
	}
	if rel.Revision != 3 {
		t.Errorf("Revision = %d, want 3", rel.Revision)
	}
	if rel.Chart != "my-chart" {
		t.Errorf("Chart = %q, want my-chart", rel.Chart)
	}
	if rel.Status != "deployed" {
		t.Errorf("Status = %q, want deployed", rel.Status)
	}
}

// ---------------------------------------------------------------------------
// GetValues
// ---------------------------------------------------------------------------

func TestGetValuesEmpty(t *testing.T) {
	ac := testActionConfig(t)
	deployed := time.Now()
	rel := testReleaseStub("no-vals", "default", 1, release.StatusDeployed, "chart", "1.0.0", deployed)
	rel.Config = nil // no user-supplied values
	if err := ac.Releases.Create(rel); err != nil {
		t.Fatalf("Create: %v", err)
	}
	withFakeActionConfig(t, ac)

	vals, err := GetValues(dummyCfg, "default", "no-vals")
	if err != nil {
		t.Fatalf("GetValues: %v", err)
	}
	// Empty values → comment placeholder.
	if !strings.Contains(vals, "No values") {
		t.Errorf("expected 'No values' placeholder, got %q", vals)
	}
}

func TestGetValuesWithConfig(t *testing.T) {
	ac := testActionConfig(t)
	deployed := time.Now()
	rel := testReleaseStub("with-vals", "default", 1, release.StatusDeployed, "chart", "1.0.0", deployed)
	rel.Config = map[string]interface{}{"replicaCount": 3, "image": map[string]interface{}{"tag": "v2"}}
	if err := ac.Releases.Create(rel); err != nil {
		t.Fatalf("Create: %v", err)
	}
	withFakeActionConfig(t, ac)

	vals, err := GetValues(dummyCfg, "default", "with-vals")
	if err != nil {
		t.Fatalf("GetValues: %v", err)
	}
	if !strings.Contains(vals, "replicaCount") {
		t.Errorf("expected replicaCount in values output, got %q", vals)
	}
}

func TestGetValuesNotFound(t *testing.T) {
	ac := testActionConfig(t)
	withFakeActionConfig(t, ac)

	_, err := GetValues(dummyCfg, "default", "no-such")
	if err == nil {
		t.Fatal("GetValues should return error for unknown release")
	}
}

// ---------------------------------------------------------------------------
// GetHistory
// ---------------------------------------------------------------------------

func TestGetHistoryEmpty(t *testing.T) {
	ac := testActionConfig(t)
	withFakeActionConfig(t, ac)

	_, err := GetHistory(dummyCfg, "default", "no-such")
	if err == nil {
		t.Fatal("GetHistory should return error for unknown release")
	}
}

func TestGetHistoryMultipleRevisionsSortedDescending(t *testing.T) {
	ac := testActionConfig(t)
	deployed := time.Date(2026, 2, 24, 0, 0, 0, 0, time.UTC)

	// Insert revisions 1, 2, 3.
	for rev := 1; rev <= 3; rev++ {
		rel := testReleaseStub("my-app", "default", rev, release.StatusSuperseded, "chart", "1.0.0", deployed)
		if rev == 3 {
			rel.Info.Status = release.StatusDeployed
		}
		if err := ac.Releases.Create(rel); err != nil {
			t.Fatalf("Create rev %d: %v", rev, err)
		}
	}
	withFakeActionConfig(t, ac)

	revisions, err := GetHistory(dummyCfg, "default", "my-app")
	if err != nil {
		t.Fatalf("GetHistory: %v", err)
	}
	if len(revisions) != 3 {
		t.Fatalf("expected 3 revisions, got %d", len(revisions))
	}
	// GetHistory sorts descending.
	if revisions[0].Revision != 3 {
		t.Errorf("revisions[0].Revision = %d, want 3", revisions[0].Revision)
	}
	if revisions[2].Revision != 1 {
		t.Errorf("revisions[2].Revision = %d, want 1", revisions[2].Revision)
	}
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

func TestUninstallNotFound(t *testing.T) {
	ac := testActionConfig(t)
	withFakeActionConfig(t, ac)

	err := Uninstall(dummyCfg, "default", "no-such")
	if err == nil {
		t.Fatal("Uninstall should return error for unknown release")
	}
}

func TestUninstallSuccess(t *testing.T) {
	ac := testActionConfig(t)
	deployed := time.Now()
	if err := ac.Releases.Create(testReleaseStub("del-me", "default", 1, release.StatusDeployed, "chart", "1.0.0", deployed)); err != nil {
		t.Fatalf("Create: %v", err)
	}
	withFakeActionConfig(t, ac)

	if err := Uninstall(dummyCfg, "default", "del-me"); err != nil {
		t.Fatalf("Uninstall: %v", err)
	}
}

// ---------------------------------------------------------------------------
// newActionConfigFn error path
// ---------------------------------------------------------------------------

func TestListReleasesActionConfigError(t *testing.T) {
	orig := newActionConfigFn
	newActionConfigFn = func(_ *rest.Config, _ string) (*action.Configuration, error) {
		return nil, fmt.Errorf("connect refused")
	}
	t.Cleanup(func() { newActionConfigFn = orig })

	_, err := ListReleases(dummyCfg, "default")
	if err == nil {
		t.Fatal("ListReleases should propagate newActionConfigFn error")
	}
}
