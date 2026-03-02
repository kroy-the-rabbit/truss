package helm

import (
	"fmt"
	"log"
	"sort"
	"time"

	"helm.sh/helm/v3/pkg/action"
	"helm.sh/helm/v3/pkg/release"
	"k8s.io/cli-runtime/pkg/genericclioptions"
	"k8s.io/client-go/rest"
	"sigs.k8s.io/yaml"
)

// newActionConfigFn is the factory for Helm action.Configuration.
// Overridable in tests via a package-level variable.
var newActionConfigFn = newActionConfig

// newActionConfig creates a Helm action.Configuration from a rest.Config and namespace.
func newActionConfig(cfg *rest.Config, namespace string) (*action.Configuration, error) {
	flags := &genericclioptions.ConfigFlags{
		APIServer:   &cfg.Host,
		BearerToken: &cfg.BearerToken,
		Namespace:   &namespace,
		WrapConfigFn: func(c *rest.Config) *rest.Config {
			c.TLSClientConfig = cfg.TLSClientConfig
			c.BearerToken = cfg.BearerToken
			c.BearerTokenFile = cfg.BearerTokenFile
			c.Username = cfg.Username
			c.Password = cfg.Password
			c.Impersonate = cfg.Impersonate
			c.AuthProvider = cfg.AuthProvider
			c.ExecProvider = cfg.ExecProvider
			return c
		},
	}

	actionConfig := new(action.Configuration)
	if err := actionConfig.Init(flags, namespace, "secrets", log.Printf); err != nil {
		return nil, fmt.Errorf("initializing helm action config: %w", err)
	}
	return actionConfig, nil
}

// Release holds simplified release information.
type Release struct {
	Name         string
	Namespace    string
	Chart        string
	ChartVersion string
	AppVersion   string
	Status       string
	Revision     int
	Updated      string
	Notes        string
}

// Revision holds release revision information.
type Revision struct {
	Revision    int
	Status      string
	Chart       string
	AppVersion  string
	Updated     string
	Description string
}

func releaseToInfo(rel *release.Release) *Release {
	r := &Release{
		Name:      rel.Name,
		Namespace: rel.Namespace,
		Revision:  rel.Version,
		Notes:     rel.Info.Notes,
		Status:    string(rel.Info.Status),
	}
	if rel.Chart != nil && rel.Chart.Metadata != nil {
		r.Chart = rel.Chart.Metadata.Name
		r.ChartVersion = rel.Chart.Metadata.Version
		r.AppVersion = rel.Chart.Metadata.AppVersion
	}
	if !rel.Info.LastDeployed.IsZero() {
		r.Updated = rel.Info.LastDeployed.UTC().Format(time.RFC3339)
	}
	return r
}

// ListReleases lists all Helm releases in the given namespace. Empty namespace lists all namespaces.
func ListReleases(cfg *rest.Config, namespace string) ([]*Release, error) {
	ac, err := newActionConfigFn(cfg, namespace)
	if err != nil {
		return nil, err
	}

	list := action.NewList(ac)
	list.AllNamespaces = namespace == ""
	list.StateMask = action.ListAll

	results, err := list.Run()
	if err != nil {
		return nil, fmt.Errorf("listing releases: %w", err)
	}

	releases := make([]*Release, 0, len(results))
	for _, rel := range results {
		releases = append(releases, releaseToInfo(rel))
	}

	sort.Slice(releases, func(i, j int) bool {
		if releases[i].Namespace != releases[j].Namespace {
			return releases[i].Namespace < releases[j].Namespace
		}
		return releases[i].Name < releases[j].Name
	})

	return releases, nil
}

// GetRelease gets a single release by name.
func GetRelease(cfg *rest.Config, namespace, name string) (*Release, error) {
	ac, err := newActionConfigFn(cfg, namespace)
	if err != nil {
		return nil, err
	}

	get := action.NewGet(ac)
	rel, err := get.Run(name)
	if err != nil {
		return nil, fmt.Errorf("getting release %q: %w", name, err)
	}

	return releaseToInfo(rel), nil
}

// GetValues returns the computed values of a release as a YAML string.
func GetValues(cfg *rest.Config, namespace, name string) (string, error) {
	ac, err := newActionConfigFn(cfg, namespace)
	if err != nil {
		return "", err
	}

	getValues := action.NewGetValues(ac)
	getValues.AllValues = true
	vals, err := getValues.Run(name)
	if err != nil {
		return "", fmt.Errorf("getting values for %q: %w", name, err)
	}

	if len(vals) == 0 {
		return "# No values configured\n", nil
	}

	yamlBytes, err := yaml.Marshal(vals)
	if err != nil {
		return "", fmt.Errorf("marshaling values: %w", err)
	}
	return string(yamlBytes), nil
}

// GetHistory returns the revision history of a release.
func GetHistory(cfg *rest.Config, namespace, name string) ([]*Revision, error) {
	ac, err := newActionConfigFn(cfg, namespace)
	if err != nil {
		return nil, err
	}

	hist := action.NewHistory(ac)
	hist.Max = 50
	releases, err := hist.Run(name)
	if err != nil {
		return nil, fmt.Errorf("getting history for %q: %w", name, err)
	}

	revisions := make([]*Revision, 0, len(releases))
	for _, rel := range releases {
		rev := &Revision{
			Revision:    rel.Version,
			Status:      string(rel.Info.Status),
			Description: rel.Info.Description,
		}
		if rel.Chart != nil && rel.Chart.Metadata != nil {
			rev.Chart = rel.Chart.Metadata.Name + "-" + rel.Chart.Metadata.Version
			rev.AppVersion = rel.Chart.Metadata.AppVersion
		}
		if !rel.Info.LastDeployed.IsZero() {
			rev.Updated = rel.Info.LastDeployed.UTC().Format(time.RFC3339)
		}
		revisions = append(revisions, rev)
	}

	sort.Slice(revisions, func(i, j int) bool {
		return revisions[i].Revision > revisions[j].Revision
	})

	return revisions, nil
}

// Uninstall removes a release.
func Uninstall(cfg *rest.Config, namespace, name string) error {
	ac, err := newActionConfigFn(cfg, namespace)
	if err != nil {
		return err
	}

	uninstall := action.NewUninstall(ac)
	_, err = uninstall.Run(name)
	if err != nil {
		return fmt.Errorf("uninstalling release %q: %w", name, err)
	}
	return nil
}

// Upgrade upgrades a release with the given values YAML.
func Upgrade(cfg *rest.Config, namespace, name, valuesYAML string) error {
	ac, err := newActionConfigFn(cfg, namespace)
	if err != nil {
		return err
	}

	get := action.NewGet(ac)
	rel, err := get.Run(name)
	if err != nil {
		return fmt.Errorf("getting current release %q: %w", name, err)
	}

	upgrade := action.NewUpgrade(ac)
	upgrade.Namespace = namespace

	var vals map[string]interface{}
	if err := yaml.Unmarshal([]byte(valuesYAML), &vals); err != nil {
		return fmt.Errorf("parsing values: %w", err)
	}
	if vals == nil {
		vals = map[string]interface{}{}
	}

	_, err = upgrade.Run(name, rel.Chart, vals)
	if err != nil {
		return fmt.Errorf("upgrading release %q: %w", name, err)
	}
	return nil
}

// Rollback rolls a release back to a specific revision.
func Rollback(cfg *rest.Config, namespace, name string, revision int) error {
	ac, err := newActionConfigFn(cfg, namespace)
	if err != nil {
		return err
	}

	rollback := action.NewRollback(ac)
	rollback.Version = revision
	if err := rollback.Run(name); err != nil {
		return fmt.Errorf("rolling back release %q to revision %d: %w", name, revision, err)
	}
	return nil
}
