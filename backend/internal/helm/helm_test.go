package helm

import (
	"testing"
	"time"

	"helm.sh/helm/v3/pkg/chart"
	"helm.sh/helm/v3/pkg/release"
	helmtime "helm.sh/helm/v3/pkg/time"
)

func makeRelease(name, ns string, version int, status release.Status,
	chartName, chartVer, appVer string, deployed time.Time, notes string) *release.Release {
	rel := &release.Release{
		Name:      name,
		Namespace: ns,
		Version:   version,
		Info: &release.Info{
			Status:       status,
			Notes:        notes,
			LastDeployed: helmtime.Time{Time: deployed},
		},
	}
	if chartName != "" {
		rel.Chart = &chart.Chart{
			Metadata: &chart.Metadata{
				Name:       chartName,
				Version:    chartVer,
				AppVersion: appVer,
			},
		}
	}
	return rel
}

func TestReleaseToInfoFieldMapping(t *testing.T) {
	deployed := time.Date(2026, 2, 24, 10, 0, 0, 0, time.UTC)
	rel := makeRelease(
		"my-app", "production", 3,
		release.StatusDeployed,
		"my-chart", "1.2.3", "v2.0.0",
		deployed, "Release notes here",
	)

	info := releaseToInfo(rel)

	if info.Name != "my-app" {
		t.Errorf("Name = %q, want my-app", info.Name)
	}
	if info.Namespace != "production" {
		t.Errorf("Namespace = %q, want production", info.Namespace)
	}
	if info.Revision != 3 {
		t.Errorf("Revision = %d, want 3", info.Revision)
	}
	if info.Status != "deployed" {
		t.Errorf("Status = %q, want deployed", info.Status)
	}
	if info.Chart != "my-chart" {
		t.Errorf("Chart = %q, want my-chart", info.Chart)
	}
	if info.ChartVersion != "1.2.3" {
		t.Errorf("ChartVersion = %q, want 1.2.3", info.ChartVersion)
	}
	if info.AppVersion != "v2.0.0" {
		t.Errorf("AppVersion = %q, want v2.0.0", info.AppVersion)
	}
	if info.Updated != "2026-02-24T10:00:00Z" {
		t.Errorf("Updated = %q, want 2026-02-24T10:00:00Z", info.Updated)
	}
	if info.Notes != "Release notes here" {
		t.Errorf("Notes = %q, want 'Release notes here'", info.Notes)
	}
}

func TestReleaseToInfoNilChart(t *testing.T) {
	// Chart and Chart.Metadata may be nil; releaseToInfo must not panic.
	rel := makeRelease("bare", "default", 1, release.StatusPendingInstall,
		"", "", "", time.Time{}, "")
	rel.Chart = nil

	info := releaseToInfo(rel)

	if info.Name != "bare" {
		t.Errorf("Name = %q, want bare", info.Name)
	}
	if info.Chart != "" {
		t.Errorf("Chart should be empty for nil chart, got %q", info.Chart)
	}
	if info.ChartVersion != "" || info.AppVersion != "" {
		t.Errorf("ChartVersion/AppVersion should be empty for nil chart")
	}
	// No deployed time → Updated must be empty.
	if info.Updated != "" {
		t.Errorf("Updated should be empty for zero deploy time, got %q", info.Updated)
	}
}

func TestReleaseToInfoNilChartMetadata(t *testing.T) {
	rel := makeRelease("bare2", "default", 2, release.StatusFailed,
		"", "", "", time.Time{}, "")
	rel.Chart = &chart.Chart{Metadata: nil}

	info := releaseToInfo(rel)
	if info.Chart != "" || info.ChartVersion != "" || info.AppVersion != "" {
		t.Error("expected empty chart fields for nil Metadata")
	}
}

func TestReleaseToInfoZeroDeployedTime(t *testing.T) {
	rel := makeRelease("test", "ns", 1, release.StatusDeployed,
		"chart", "1.0.0", "1.0", time.Time{}, "")

	info := releaseToInfo(rel)
	if info.Updated != "" {
		t.Errorf("Updated should be empty for zero deploy time, got %q", info.Updated)
	}
}

func TestReleaseToInfoStatusValues(t *testing.T) {
	statuses := []struct {
		status release.Status
		want   string
	}{
		{release.StatusDeployed, "deployed"},
		{release.StatusFailed, "failed"},
		{release.StatusPendingInstall, "pending-install"},
		{release.StatusUninstalled, "uninstalled"},
	}
	for _, tt := range statuses {
		rel := makeRelease("r", "ns", 1, tt.status, "c", "1.0", "1.0", time.Time{}, "")
		info := releaseToInfo(rel)
		if info.Status != tt.want {
			t.Errorf("Status for %v = %q, want %q", tt.status, info.Status, tt.want)
		}
	}
}
