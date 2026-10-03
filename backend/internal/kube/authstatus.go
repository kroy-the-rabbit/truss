package kube

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	osexec "os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

// Kind classifies why a cluster call failed.
type Kind string

const (
	KindNone                       Kind = ""
	KindAuthRequired               Kind = "AUTH_REQUIRED"
	KindAuthPluginMissing          Kind = "AUTH_PLUGIN_MISSING"
	KindAuthInteractiveUnsupported Kind = "AUTH_INTERACTIVE_UNSUPPORTED"
	KindAuthRejected               Kind = "AUTH_REJECTED"
	KindForbidden                  Kind = "FORBIDDEN"
	KindUnreachable                Kind = "UNREACHABLE"
	KindTLS                        Kind = "TLS"
	KindUnknown                    Kind = "UNKNOWN"
)

// IsAuth reports whether the kind is one of the AUTH_* kinds that trip the
// per-context circuit breaker.
func (k Kind) IsAuth() bool {
	switch k {
	case KindAuthRequired, KindAuthPluginMissing, KindAuthInteractiveUnsupported, KindAuthRejected:
		return true
	}
	return false
}

// Health states.
const (
	StateOK      = "ok"
	StateError   = "error"
	StateUnknown = "unknown"
)

// ContextHealth is the externally visible health of a context. JSON shape is
// part of the frontend contract.
type ContextHealth struct {
	Context          string `json:"context"`
	State            string `json:"state"`
	Kind             Kind   `json:"kind"`
	Message          string `json:"message"`
	PluginCommand    string `json:"plugin_command"`
	SuggestedCommand string `json:"suggested_command"`
	Stderr           string `json:"stderr"`
	Since            string `json:"since"`
}

// AuthError is returned while a context's circuit breaker is open. It carries
// the recorded health so callers can classify it without re-running anything.
type AuthError struct {
	Health ContextHealth
}

func (e *AuthError) Error() string { return e.Health.Message }

var (
	execNotFoundRe = regexp.MustCompile(`exec: executable \S+ not found`)
	execExitRe     = regexp.MustCompile(`exec: executable \S+ failed with exit code`)
)

// Classify maps an error from client construction or a cluster call to a Kind.
// It returns KindNone for a nil error.
func Classify(err error) Kind {
	if err == nil {
		return KindNone
	}
	var ae *AuthError
	if errors.As(err, &ae) {
		return ae.Health.Kind
	}
	if apierrors.IsUnauthorized(err) {
		return KindAuthRejected
	}
	if apierrors.IsForbidden(err) {
		return KindForbidden
	}

	msg := err.Error()
	switch {
	case strings.Contains(msg, "cannot support interactive mode"),
		strings.Contains(msg, "standard input is not a terminal"),
		strings.Contains(msg, "standard input is unavailable"):
		return KindAuthInteractiveUnsupported
	case execNotFoundRe.MatchString(msg),
		errors.Is(err, osexec.ErrNotFound):
		return KindAuthPluginMissing
	case execExitRe.MatchString(msg), strings.Contains(msg, "getting credentials:"):
		return KindAuthRequired
	}

	if isTLSError(err) {
		return KindTLS
	}
	if isUnreachable(err) {
		return KindUnreachable
	}
	return KindUnknown
}

func isTLSError(err error) bool {
	var unknownAuth x509.UnknownAuthorityError
	var certInvalid x509.CertificateInvalidError
	var hostname x509.HostnameError
	var verify *tls.CertificateVerificationError
	var recordHeader tls.RecordHeaderError
	if errors.As(err, &unknownAuth) || errors.As(err, &certInvalid) || errors.As(err, &hostname) ||
		errors.As(err, &verify) || errors.As(err, &recordHeader) {
		return true
	}
	msg := err.Error()
	return strings.Contains(msg, "x509:") || strings.Contains(msg, "tls: ")
}

func isUnreachable(err error) bool {
	if errors.Is(err, context.Canceled) {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) ||
		errors.Is(err, syscall.ECONNREFUSED) ||
		errors.Is(err, syscall.EHOSTUNREACH) ||
		errors.Is(err, syscall.ENETUNREACH) ||
		errors.Is(err, syscall.ECONNRESET) {
		return true
	}
	var opErr *net.OpError
	var dnsErr *net.DNSError
	if errors.As(err, &opErr) || errors.As(err, &dnsErr) {
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}
	msg := err.Error()
	for _, s := range []string{
		"connection refused", "no such host", "i/o timeout", "no route to host",
		"network is unreachable", "Client.Timeout exceeded", "TLS handshake timeout",
		"connection reset by peer",
	} {
		if strings.Contains(msg, s) {
			return true
		}
	}
	return false
}

// ExecConfigFromKubeconfig returns the exec credential plugin config for the
// kubeconfig's current context, or nil when the context does not use one.
func ExecConfigFromKubeconfig(kubeconfigYAML string) (*clientcmdapi.ExecConfig, error) {
	cfg, err := clientcmd.Load([]byte(kubeconfigYAML))
	if err != nil {
		return nil, fmt.Errorf("parsing kubeconfig: %w", err)
	}
	if cfg.CurrentContext == "" {
		return nil, nil
	}
	ctx, ok := cfg.Contexts[cfg.CurrentContext]
	if !ok || ctx == nil || strings.TrimSpace(ctx.AuthInfo) == "" {
		return nil, nil
	}
	user, ok := cfg.AuthInfos[ctx.AuthInfo]
	if !ok || user == nil || user.Exec == nil {
		return nil, nil
	}
	if strings.TrimSpace(user.Exec.Command) == "" {
		return nil, nil
	}
	return user.Exec, nil
}

// PluginCommandLine renders the plugin argv as a copy-pasteable command line.
func PluginCommandLine(execCfg *clientcmdapi.ExecConfig) string {
	if execCfg == nil {
		return ""
	}
	parts := make([]string, 0, len(execCfg.Args)+1)
	parts = append(parts, shellQuote(strings.TrimSpace(execCfg.Command)))
	for _, a := range execCfg.Args {
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

func hasArg(args []string, want string) bool {
	for _, a := range args {
		if a == want {
			return true
		}
	}
	return false
}

func hasArgPrefix(args []string, prefix string) bool {
	for _, a := range args {
		if strings.HasPrefix(a, prefix) {
			return true
		}
	}
	return false
}

func awsProfile(execCfg *clientcmdapi.ExecConfig) string {
	for _, e := range execCfg.Env {
		if e.Name == "AWS_PROFILE" && strings.TrimSpace(e.Value) != "" {
			return strings.TrimSpace(e.Value)
		}
	}
	for i, a := range execCfg.Args {
		if a == "--profile" && i+1 < len(execCfg.Args) {
			return execCfg.Args[i+1]
		}
		if v, ok := strings.CutPrefix(a, "--profile="); ok && v != "" {
			return v
		}
	}
	return ""
}

// SuggestedCommand returns the command a user should run in a terminal to
// re-establish credentials for the given exec plugin.
func SuggestedCommand(execCfg *clientcmdapi.ExecConfig) string {
	if execCfg == nil || strings.TrimSpace(execCfg.Command) == "" {
		return ""
	}
	base := strings.TrimSuffix(filepath.Base(strings.TrimSpace(execCfg.Command)), ".exe")
	args := execCfg.Args
	switch {
	case base == "gke-gcloud-auth-plugin":
		return "gcloud auth login"
	case (base == "aws" && hasArg(args, "eks") && hasArg(args, "get-token")) || base == "aws-iam-authenticator":
		if p := awsProfile(execCfg); p != "" {
			return "aws sso login --profile " + shellQuote(p)
		}
		return "aws sso login"
	case base == "kubectl-oidc_login", base == "kubectl" && len(args) > 0 && args[0] == "oidc-login":
		return PluginCommandLine(execCfg)
	case base == "kubelogin":
		if hasArgPrefix(args, "--oidc-issuer-url") {
			return PluginCommandLine(execCfg)
		}
		return "az login"
	}
	return PluginCommandLine(execCfg)
}

// describeKind gives a short human-readable prefix for a classified failure.
func describeKind(contextName string, k Kind) string {
	switch k {
	case KindAuthRequired:
		return fmt.Sprintf("Credentials for context %q need to be refreshed", contextName)
	case KindAuthPluginMissing:
		return fmt.Sprintf("The credential plugin for context %q is not installed or not on PATH", contextName)
	case KindAuthInteractiveUnsupported:
		return fmt.Sprintf("The credential plugin for context %q needs an interactive login", contextName)
	case KindAuthRejected:
		return fmt.Sprintf("The cluster rejected the credentials for context %q", contextName)
	case KindForbidden:
		return fmt.Sprintf("Access denied for context %q", contextName)
	case KindUnreachable:
		return fmt.Sprintf("Cluster for context %q is unreachable", contextName)
	case KindTLS:
		return fmt.Sprintf("TLS verification failed for context %q", contextName)
	}
	return fmt.Sprintf("Request failed for context %q", contextName)
}

// conciseError strips client-go's request URL prefix from exec failures so the
// message reads as the actual cause.
func conciseError(err error) string {
	msg := err.Error()
	if i := strings.Index(msg, "getting credentials: "); i >= 0 {
		msg = msg[i+len("getting credentials: "):]
	}
	if i := strings.Index(msg, "\n"); i >= 0 {
		msg = msg[:i]
	}
	return strings.TrimSpace(msg)
}

// HealthMessage builds a human-readable message for a classified error.
func HealthMessage(contextName string, k Kind, err error) string {
	if err == nil {
		return describeKind(contextName, k)
	}
	return describeKind(contextName, k) + ": " + conciseError(err)
}
