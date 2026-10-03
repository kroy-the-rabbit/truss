package execconsent

import (
	"strings"
	"testing"
)

const baseKC = `apiVersion: v1
kind: Config
current-context: prod
clusters:
- name: c
  cluster:
    server: https://example.invalid
contexts:
- name: prod
  context: {cluster: c, user: u}
- name: other
  context: {cluster: c, user: plain}
users:
- name: plain
  user:
    token: abc
- name: u
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      args: [eks, get-token, --cluster-name, prod]
      env:
      - {name: AWS_PROFILE, value: prod}
      - {name: SECRET_TOKEN, value: hunter2}
`

func mustExtract(t *testing.T, kc, ctx string) *SensitiveAuth {
	t.Helper()
	s, err := Extract(kc, ctx)
	if err != nil {
		t.Fatalf("Extract: %v", err)
	}
	return s
}

func TestExtractExec(t *testing.T) {
	s := mustExtract(t, baseKC, "")
	if !s.IsSensitive() || s.Exec == nil {
		t.Fatalf("expected exec, got %+v", s)
	}
	if s.Exec.Command != "aws" || strings.Join(s.Exec.Args, " ") != "eks get-token --cluster-name prod" {
		t.Fatalf("exec = %+v", s.Exec)
	}
	if strings.Join(s.Exec.EnvNames, ",") != "AWS_PROFILE,SECRET_TOKEN" {
		t.Fatalf("env names = %v", s.Exec.EnvNames)
	}
	if s.Exec.CommandLine != "aws eks get-token --cluster-name prod" || len(s.Fingerprint) != 64 {
		t.Fatalf("command line %q fingerprint %q", s.Exec.CommandLine, s.Fingerprint)
	}
	// Env values are fingerprinted but never exposed.
	if strings.Contains(s.Exec.CommandLine+strings.Join(s.Exec.EnvNames, ""), "hunter2") {
		t.Fatal("env value leaked")
	}

	// Named context selection; a context without exec is not sensitive.
	if o := mustExtract(t, baseKC, "other"); o.IsSensitive() || o.Fingerprint != "" {
		t.Fatalf("other = %+v", o)
	}
	// Unknown context name falls back to current-context.
	if f := mustExtract(t, baseKC, "nope"); f.Fingerprint != s.Fingerprint {
		t.Fatal("fallback to current-context failed")
	}
}

func TestFingerprintStableAndSensitiveToChanges(t *testing.T) {
	base := mustExtract(t, baseKC, "").Fingerprint
	if again := mustExtract(t, baseKC, "").Fingerprint; again != base {
		t.Fatal("fingerprint not stable")
	}
	// Cosmetic YAML changes and non-auth fields do not matter.
	reformatted := strings.Replace(baseKC, "server: https://example.invalid", "server: https://other.invalid", 1)
	if mustExtract(t, reformatted, "").Fingerprint != base {
		t.Fatal("cluster server change altered fingerprint")
	}

	for name, kc := range map[string]string{
		"args":       strings.Replace(baseKC, "--cluster-name, prod]", "--cluster-name, evil]", 1),
		"command":    strings.Replace(baseKC, "command: aws", "command: sh", 1),
		"env value":  strings.Replace(baseKC, "value: hunter2", "value: other", 1),
		"env name":   strings.Replace(baseKC, "name: AWS_PROFILE", "name: LD_PRELOAD", 1),
		"apiVersion": strings.Replace(baseKC, "apiVersion: client.authentication.k8s.io/v1beta1", "apiVersion: client.authentication.k8s.io/v1", 1),
	} {
		if fp := mustExtract(t, kc, "").Fingerprint; fp == base || fp == "" {
			t.Errorf("%s change did not alter fingerprint", name)
		}
	}
}

func TestAuthProviderAndFileRefs(t *testing.T) {
	kc := `apiVersion: v1
kind: Config
current-context: x
clusters:
- name: c
  cluster:
    server: https://example.invalid
    certificate-authority: /etc/ca.pem
contexts:
- name: x
  context: {cluster: c, user: u}
users:
- name: u
  user:
    tokenFile: /home/me/token
    client-certificate: /home/me/cert.pem
    client-key: /home/me/key.pem
    auth-provider:
      name: oidc
      config:
        idp-issuer-url: https://issuer.invalid
        id-token: one
`
	s := mustExtract(t, kc, "")
	if s.Exec != nil || s.AuthProvider != "oidc" || !s.IsSensitive() {
		t.Fatalf("got %+v", s)
	}
	var got []string
	for _, f := range s.FileRefs {
		got = append(got, f.Field+"="+f.Path)
	}
	want := "cluster.certificate-authority=/etc/ca.pem,user.client-certificate=/home/me/cert.pem,user.client-key=/home/me/key.pem,user.tokenFile=/home/me/token"
	if strings.Join(got, ",") != want {
		t.Fatalf("file refs = %v", got)
	}
	// Refreshed tokens do not revoke approval; a changed issuer or path does.
	if mustExtract(t, strings.Replace(kc, "id-token: one", "id-token: two", 1), "").Fingerprint != s.Fingerprint {
		t.Fatal("id-token refresh changed fingerprint")
	}
	if mustExtract(t, strings.Replace(kc, "issuer.invalid", "evil.invalid", 1), "").Fingerprint == s.Fingerprint {
		t.Fatal("issuer change did not alter fingerprint")
	}
	if mustExtract(t, strings.Replace(kc, "/home/me/token", "/etc/shadow", 1), "").Fingerprint == s.Fingerprint {
		t.Fatal("file path change did not alter fingerprint")
	}
}

func TestExtractInvalidYAML(t *testing.T) {
	if _, err := Extract("{not yaml", ""); err == nil {
		t.Fatal("expected parse error")
	}
}
