// Package execconsent extracts the parts of a kubeconfig that make client-go
// run local commands or read local files (exec credential plugins,
// auth-providers and file references) and fingerprints them, so Truss can
// require explicit user approval before building a client for a context.
//
// It depends only on clientcmd so both the context store (for migration) and
// the kube client manager (for enforcement) can use it.
package execconsent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"k8s.io/client-go/tools/clientcmd"
)

// ExecInfo describes a kubeconfig exec credential plugin.
type ExecInfo struct {
	Command         string   `json:"command"`
	Args            []string `json:"args"`
	EnvNames        []string `json:"env_names"`
	APIVersion      string   `json:"api_version,omitempty"`
	InteractiveMode string   `json:"interactive_mode,omitempty"`
	// CommandLine is Command+Args rendered as a copy-pasteable shell line.
	CommandLine string `json:"command_line"`
}

// FileRef is a local file client-go reads for this context.
type FileRef struct {
	Field string `json:"field"` // e.g. "user.tokenFile", "cluster.certificate-authority"
	Path  string `json:"path"`
}

// SensitiveAuth is the externally visible description of what a context will
// execute or read locally. JSON shape is part of the frontend contract.
type SensitiveAuth struct {
	Exec         *ExecInfo `json:"exec,omitempty"`
	AuthProvider string    `json:"auth_provider,omitempty"`
	FileRefs     []FileRef `json:"file_refs,omitempty"`
	Fingerprint  string    `json:"fingerprint"`
}

// IsSensitive reports whether the context runs a command or follows a
// local file reference (and so needs approval).
func (s *SensitiveAuth) IsSensitive() bool {
	return s != nil && (s.Exec != nil || s.AuthProvider != "" || len(s.FileRefs) > 0)
}

// Volatile auth-provider config keys hold credentials client-go refreshes;
// they are excluded from the fingerprint so a token refresh does not revoke
// approval. Everything else (e.g. cmd-path, cmd-args) is included.
var volatileAuthProviderKeys = map[string]struct{}{
	"access-token":  {},
	"id-token":      {},
	"refresh-token": {},
	"expiry":        {},
}

type canonicalEnv struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type canonicalExec struct {
	Command    string         `json:"command"`
	Args       []string       `json:"args"`
	Env        []canonicalEnv `json:"env"`
	APIVersion string         `json:"api_version"`
}

type canonicalAuthProvider struct {
	Name   string            `json:"name"`
	Config map[string]string `json:"config"`
}

type canonical struct {
	Exec         *canonicalExec         `json:"exec"`
	AuthProvider *canonicalAuthProvider `json:"auth_provider"`
	Files        []FileRef              `json:"files"`
}

// Extract parses kubeconfigYAML and returns the sensitive auth for
// contextName (or the current-context when contextName is empty or absent).
// A context with nothing sensitive returns a SensitiveAuth with an empty
// Fingerprint and IsSensitive() == false.
func Extract(kubeconfigYAML, contextName string) (*SensitiveAuth, error) {
	cfg, err := clientcmd.Load([]byte(kubeconfigYAML))
	if err != nil {
		return nil, fmt.Errorf("parsing kubeconfig: %w", err)
	}
	name := strings.TrimSpace(contextName)
	if _, ok := cfg.Contexts[name]; name == "" || !ok {
		name = cfg.CurrentContext
	}
	out := &SensitiveAuth{}
	ctx, ok := cfg.Contexts[name]
	if !ok || ctx == nil {
		return out, nil
	}
	var c canonical

	if user := cfg.AuthInfos[ctx.AuthInfo]; user != nil {
		if ex := user.Exec; ex != nil && strings.TrimSpace(ex.Command) != "" {
			info := &ExecInfo{
				Command:         strings.TrimSpace(ex.Command),
				Args:            append([]string{}, ex.Args...),
				EnvNames:        []string{},
				APIVersion:      ex.APIVersion,
				InteractiveMode: string(ex.InteractiveMode),
			}
			ce := &canonicalExec{Command: info.Command, Args: info.Args, Env: []canonicalEnv{}, APIVersion: ex.APIVersion}
			for _, e := range ex.Env {
				info.EnvNames = append(info.EnvNames, e.Name)
				ce.Env = append(ce.Env, canonicalEnv{Name: e.Name, Value: e.Value})
			}
			info.CommandLine = CommandLine(info.Command, info.Args)
			out.Exec = info
			c.Exec = ce
		}
		if ap := user.AuthProvider; ap != nil && strings.TrimSpace(ap.Name) != "" {
			out.AuthProvider = strings.TrimSpace(ap.Name)
			apc := &canonicalAuthProvider{Name: out.AuthProvider, Config: map[string]string{}}
			for k, v := range ap.Config {
				if _, volatile := volatileAuthProviderKeys[k]; !volatile {
					apc.Config[k] = v
				}
			}
			c.AuthProvider = apc
		}
		addFile(out, "user.tokenFile", user.TokenFile)
		addFile(out, "user.client-certificate", user.ClientCertificate)
		addFile(out, "user.client-key", user.ClientKey)
	}
	if cluster := cfg.Clusters[ctx.Cluster]; cluster != nil {
		addFile(out, "cluster.certificate-authority", cluster.CertificateAuthority)
	}
	sort.Slice(out.FileRefs, func(i, j int) bool {
		if out.FileRefs[i].Field != out.FileRefs[j].Field {
			return out.FileRefs[i].Field < out.FileRefs[j].Field
		}
		return out.FileRefs[i].Path < out.FileRefs[j].Path
	})

	if !out.IsSensitive() {
		return out, nil
	}
	c.Files = append([]FileRef{}, out.FileRefs...)
	b, err := json.Marshal(c) // map keys are marshalled sorted
	if err != nil {
		return nil, fmt.Errorf("encoding fingerprint input: %w", err)
	}
	sum := sha256.Sum256(b)
	out.Fingerprint = hex.EncodeToString(sum[:])
	return out, nil
}

func addFile(out *SensitiveAuth, field, path string) {
	if p := strings.TrimSpace(path); p != "" {
		out.FileRefs = append(out.FileRefs, FileRef{Field: field, Path: p})
	}
}

// Fingerprint returns the approval fingerprint for a stored kubeconfig, or ""
// when it has nothing that needs approval.
func Fingerprint(kubeconfigYAML string) (string, error) {
	s, err := Extract(kubeconfigYAML, "")
	if err != nil {
		return "", err
	}
	return s.Fingerprint, nil
}

// CommandLine renders argv as a copy-pasteable shell command line.
func CommandLine(command string, args []string) string {
	parts := make([]string, 0, len(args)+1)
	parts = append(parts, shellQuote(strings.TrimSpace(command)))
	for _, a := range args {
		parts = append(parts, shellQuote(a))
	}
	return strings.Join(parts, " ")
}

func shellQuote(s string) string {
	if s == "" {
		return "''"
	}
	if strings.IndexFunc(s, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' ||
			strings.ContainsRune("-_./=:,@+%", r))
	}) < 0 {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'"'"'`) + "'"
}
