package kube

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/url"
	"syscall"
	"testing"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

func urlErr(err error) error {
	return &url.Error{Op: "Get", URL: "https://10.0.0.1/api?timeout=32s", Err: err}
}

func TestClassify(t *testing.T) {
	podsGR := schema.GroupResource{Resource: "pods"}
	tests := []struct {
		name string
		err  error
		want Kind
	}{
		{"nil", nil, KindNone},
		{"exec exit code (gke)", urlErr(fmt.Errorf("getting credentials: %v",
			errors.New("exec: executable gke-gcloud-auth-plugin failed with exit code 1"))), KindAuthRequired},
		{"exec exit code (aws)", urlErr(errors.New("getting credentials: exec: executable aws failed with exit code 255")), KindAuthRequired},
		{"exec decode failure", urlErr(errors.New("getting credentials: decoding stdout: couldn't get version/kind")), KindAuthRequired},
		{"exec not found", urlErr(errors.New("getting credentials: exec: executable kubelogin not found\n\nIt looks like you are trying to use a client-go credential plugin that is not installed.")), KindAuthPluginMissing},
		{"interactive unsupported", urlErr(errors.New("getting credentials: exec plugin cannot support interactive mode: standard input is not a terminal")), KindAuthInteractiveUnsupported},
		{"stdin unavailable", urlErr(errors.New("getting credentials: exec plugin cannot support interactive mode: standard input is unavailable")), KindAuthInteractiveUnsupported},
		{"unauthorized", apierrors.NewUnauthorized("Unauthorized"), KindAuthRejected},
		{"wrapped unauthorized", fmt.Errorf("listing namespaces: %w", apierrors.NewUnauthorized("")), KindAuthRejected},
		{"forbidden", apierrors.NewForbidden(podsGR, "", errors.New("RBAC denied")), KindForbidden},
		{"wrapped forbidden", fmt.Errorf("listing resources: %w", apierrors.NewForbidden(podsGR, "x", errors.New("no"))), KindForbidden},
		{"connection refused", urlErr(&net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNREFUSED}), KindUnreachable},
		{"dns", urlErr(&net.OpError{Op: "dial", Net: "tcp", Err: &net.DNSError{Err: "no such host", Name: "k8s.example", IsNotFound: true}}), KindUnreachable},
		{"deadline", urlErr(context.DeadlineExceeded), KindUnreachable},
		{"client timeout string", errors.New(`Get "https://x/api": net/http: request canceled (Client.Timeout exceeded while awaiting headers)`), KindUnreachable},
		{"x509 unknown authority", urlErr(&tls.CertificateVerificationError{Err: x509.UnknownAuthorityError{}}), KindTLS},
		{"x509 hostname", urlErr(x509.HostnameError{Certificate: &x509.Certificate{}, Host: "a"}), KindTLS},
		{"x509 string", errors.New(`Get "https://x/api": tls: failed to verify certificate: x509: certificate has expired or is not yet valid`), KindTLS},
		{"not found", apierrors.NewNotFound(podsGR, "x"), KindUnknown},
		{"canceled", urlErr(context.Canceled), KindUnknown},
		{"breaker error", fmt.Errorf("listing: %w", &AuthError{Health: ContextHealth{Kind: KindAuthRequired}}), KindAuthRequired},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Classify(tt.err); got != tt.want {
				t.Fatalf("Classify(%v) = %q, want %q", tt.err, got, tt.want)
			}
		})
	}
}

func TestKindIsAuth(t *testing.T) {
	for _, k := range []Kind{KindAuthRequired, KindAuthPluginMissing, KindAuthInteractiveUnsupported, KindAuthRejected} {
		if !k.IsAuth() {
			t.Errorf("%s should be auth", k)
		}
	}
	for _, k := range []Kind{KindNone, KindForbidden, KindUnreachable, KindTLS, KindUnknown} {
		if k.IsAuth() {
			t.Errorf("%s should not be auth", k)
		}
	}
}

func TestSuggestedCommand(t *testing.T) {
	tests := []struct {
		name string
		cfg  *clientcmdapi.ExecConfig
		want string
	}{
		{"nil", nil, ""},
		{"gke", &clientcmdapi.ExecConfig{Command: "gke-gcloud-auth-plugin"}, "gcloud auth login"},
		{"gke abs path", &clientcmdapi.ExecConfig{Command: "/opt/google-cloud-sdk/bin/gke-gcloud-auth-plugin"}, "gcloud auth login"},
		{"aws env profile", &clientcmdapi.ExecConfig{
			Command: "aws",
			Args:    []string{"--region", "us-east-1", "eks", "get-token", "--cluster-name", "prod"},
			Env:     []clientcmdapi.ExecEnvVar{{Name: "AWS_PROFILE", Value: "prod-admin"}},
		}, "aws sso login --profile prod-admin"},
		{"aws arg profile", &clientcmdapi.ExecConfig{
			Command: "aws",
			Args:    []string{"eks", "get-token", "--cluster-name", "prod", "--profile", "dev"},
		}, "aws sso login --profile dev"},
		{"aws arg profile equals", &clientcmdapi.ExecConfig{
			Command: "aws",
			Args:    []string{"eks", "get-token", "--profile=dev2"},
		}, "aws sso login --profile dev2"},
		{"aws no profile", &clientcmdapi.ExecConfig{Command: "aws", Args: []string{"eks", "get-token", "--cluster-name", "c"}}, "aws sso login"},
		{"aws-iam-authenticator", &clientcmdapi.ExecConfig{
			Command: "aws-iam-authenticator",
			Args:    []string{"token", "-i", "c"},
			Env:     []clientcmdapi.ExecEnvVar{{Name: "AWS_PROFILE", Value: "p"}},
		}, "aws sso login --profile p"},
		{"azure kubelogin", &clientcmdapi.ExecConfig{
			Command: "kubelogin",
			Args:    []string{"get-token", "--login", "azurecli", "--server-id", "6dae42f8"},
		}, "az login"},
		{"oidc kubelogin", &clientcmdapi.ExecConfig{
			Command: "kubelogin",
			Args:    []string{"get-token", "--oidc-issuer-url=https://issuer.example", "--oidc-client-id=abc"},
		}, "kubelogin get-token --oidc-issuer-url=https://issuer.example --oidc-client-id=abc"},
		{"kubectl oidc-login", &clientcmdapi.ExecConfig{
			Command: "kubectl",
			Args:    []string{"oidc-login", "get-token", "--oidc-issuer-url=https://issuer.example"},
		}, "kubectl oidc-login get-token --oidc-issuer-url=https://issuer.example"},
		{"other plugin", &clientcmdapi.ExecConfig{
			Command: "/usr/local/bin/my-auth",
			Args:    []string{"login", "--scope", "a b"},
		}, "/usr/local/bin/my-auth login --scope 'a b'"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := SuggestedCommand(tt.cfg); got != tt.want {
				t.Fatalf("SuggestedCommand = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestExecConfigFromKubeconfig(t *testing.T) {
	cfg, err := ExecConfigFromKubeconfig(fakeKubeconfig)
	if err != nil || cfg != nil {
		t.Fatalf("token kubeconfig: cfg=%v err=%v, want nil/nil", cfg, err)
	}
	if _, err := ExecConfigFromKubeconfig("not: valid: yaml: {{{{"); err == nil {
		t.Fatal("expected parse error")
	}
	cfg, err = ExecConfigFromKubeconfig(execKubeconfig("http://127.0.0.1:1", "/bin/plugin", "/tmp/count"))
	if err != nil || cfg == nil || cfg.Command != "/bin/plugin" {
		t.Fatalf("exec kubeconfig: cfg=%v err=%v", cfg, err)
	}
}

func TestHealthMessageStripsURLPrefix(t *testing.T) {
	err := urlErr(errors.New("getting credentials: exec: executable aws failed with exit code 255"))
	got := HealthMessage("prod", KindAuthRequired, err)
	want := `Credentials for context "prod" need to be refreshed: exec: executable aws failed with exit code 255`
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}
