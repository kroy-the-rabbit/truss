package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"google.golang.org/protobuf/reflect/protoreflect"

	pb "github.com/kroy/truss/backend/api/gen/go/truss/v1"
	"github.com/kroy/truss/backend/api/gen/go/truss/v1/trussv1connect"
)

// readProcedures lists every non-mutating Connect procedure. Together with
// mutatingProcedures it must cover every RPC in the proto services, so a new
// RPC cannot be added without deciding whether read-only mode blocks it.
var readProcedures = []string{
	trussv1connect.HealthServicePingProcedure,
	trussv1connect.ContextsServiceListContextsProcedure,
	trussv1connect.ContextsServiceSetActiveContextProcedure,
	trussv1connect.ContextsServiceListNamespacesProcedure,
	trussv1connect.DiscoveryServiceListResourceKindsProcedure,
	trussv1connect.HelmServiceListReleasesProcedure,
	trussv1connect.HelmServiceGetReleaseProcedure,
	trussv1connect.HelmServiceGetReleaseValuesProcedure,
	trussv1connect.HelmServiceGetReleaseHistoryProcedure,
	trussv1connect.OverviewServiceGetClusterOverviewProcedure,
	trussv1connect.ResourcesServiceListResourcesProcedure,
	trussv1connect.ResourcesServiceGetResourceProcedure,
	trussv1connect.ResourcesServiceGetResourceCountsProcedure,
	trussv1connect.ResourcesServiceListEventsProcedure,
	trussv1connect.ResourcesServiceGetLogsProcedure,
	trussv1connect.ResourcesServiceGetPodInfoProcedure,
	trussv1connect.ResourcesServiceGetOwnedPodsProcedure,
	trussv1connect.YamlServiceGetYamlProcedure,
	trussv1connect.YamlServiceDiffYamlProcedure,
}

func TestProcedureClassificationCoversAllRPCs(t *testing.T) {
	known := map[string]bool{}
	for p := range mutatingProcedures {
		known[p] = true
	}
	for _, p := range readProcedures {
		if known[p] {
			t.Errorf("%s is classified as both read and mutating", p)
		}
		known[p] = true
	}
	files := []protoreflect.FileDescriptor{
		pb.File_truss_v1_contexts_proto,
		pb.File_truss_v1_discovery_proto,
		pb.File_truss_v1_health_proto,
		pb.File_truss_v1_helm_proto,
		pb.File_truss_v1_overview_proto,
		pb.File_truss_v1_resources_proto,
		pb.File_truss_v1_yaml_proto,
	}
	total := 0
	for _, fd := range files {
		svcs := fd.Services()
		for i := 0; i < svcs.Len(); i++ {
			svc := svcs.Get(i)
			methods := svc.Methods()
			for j := 0; j < methods.Len(); j++ {
				total++
				proc := "/" + string(svc.FullName()) + "/" + string(methods.Get(j).Name())
				if !known[proc] {
					t.Errorf("procedure %s is not classified as read or mutating", proc)
				}
			}
		}
	}
	if total != len(known) {
		t.Errorf("classified %d procedures but proto services define %d", len(known), total)
	}
}

func TestNewServerStartsReadOnly(t *testing.T) {
	s := New(nil, nil, "test")
	if !s.ReadOnly() {
		t.Fatal("New() server must start in read-only mode")
	}
	var zero Server
	if !zero.ReadOnly() {
		t.Fatal("zero-value Server must be read-only (fail closed)")
	}
}

// callConnect performs a Connect-protocol unary JSON call with an empty
// request message and returns the HTTP status and the Connect error code.
func callConnect(t *testing.T, baseURL, procedure string) (int, string) {
	t.Helper()
	resp, err := http.Post(baseURL+procedure, "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("POST %s: %v", procedure, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var e struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(body, &e)
	if e.Code == "permission_denied" && e.Message != readOnlyMessage {
		t.Errorf("%s: permission_denied with unexpected message %q", procedure, e.Message)
	}
	return resp.StatusCode, e.Code
}

func newReadOnlyTestServer(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	s := newSetupServer(t)
	ts := httptest.NewServer(s.newMux(""))
	t.Cleanup(ts.Close)
	return s, ts
}

func TestReadOnlyInterceptorBlocksMutatingProcedures(t *testing.T) {
	s, ts := newReadOnlyTestServer(t)
	s.SetReadOnly(true)
	for proc := range mutatingProcedures {
		status, code := callConnect(t, ts.URL, proc)
		if status != http.StatusForbidden || code != "permission_denied" {
			t.Errorf("%s in RO mode: status=%d code=%q, want 403 permission_denied", proc, status, code)
		}
	}
}

func TestReadOnlyInterceptorAllowsMutatingProceduresInWriteMode(t *testing.T) {
	s, ts := newReadOnlyTestServer(t)
	s.SetReadOnly(false)
	for proc := range mutatingProcedures {
		// The handler runs and fails for other reasons (no cluster), but it
		// must not be rejected by the read-only gate.
		_, code := callConnect(t, ts.URL, proc)
		if code == "permission_denied" {
			t.Errorf("%s in write mode was rejected with permission_denied", proc)
		}
	}
}

func TestReadOnlyInterceptorAllowsReadProcedures(t *testing.T) {
	s, ts := newReadOnlyTestServer(t)
	s.SetReadOnly(true)
	// A subset of read RPCs that are safe to invoke without a cluster.
	for _, proc := range []string{
		trussv1connect.HealthServicePingProcedure,
		trussv1connect.ContextsServiceListContextsProcedure,
		trussv1connect.YamlServiceGetYamlProcedure,
		trussv1connect.YamlServiceDiffYamlProcedure,
		trussv1connect.HelmServiceListReleasesProcedure,
		trussv1connect.ResourcesServiceGetResourceProcedure,
	} {
		status, code := callConnect(t, ts.URL, proc)
		if code == "permission_denied" {
			t.Errorf("%s in RO mode was rejected (status %d)", proc, status)
		}
	}
	status, code := callConnect(t, ts.URL, trussv1connect.HealthServicePingProcedure)
	if status != http.StatusOK {
		t.Errorf("Ping in RO mode: status=%d code=%q, want 200", status, code)
	}
}

func TestHandleReadOnlyEndpoint(t *testing.T) {
	s := newSetupServer(t)
	s.SetReadOnly(true)

	get := func() bool {
		t.Helper()
		rr := httptest.NewRecorder()
		s.handleReadOnly(rr, httptest.NewRequest(http.MethodGet, "/api/readonly", nil))
		if rr.Code != http.StatusOK {
			t.Fatalf("GET status = %d, want 200", rr.Code)
		}
		var body map[string]bool
		if err := json.NewDecoder(rr.Body).Decode(&body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return body["readonly"]
	}

	if !get() {
		t.Fatal("expected readonly=true initially")
	}

	for _, want := range []bool{false, true} {
		rr := httptest.NewRecorder()
		s.handleReadOnly(rr, httptest.NewRequest(http.MethodPost, "/api/readonly", toJSONBody(t, map[string]bool{"readonly": want})))
		if rr.Code != http.StatusOK {
			t.Fatalf("POST status = %d, want 200", rr.Code)
		}
		var body map[string]bool
		if err := json.NewDecoder(rr.Body).Decode(&body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if body["readonly"] != want || s.ReadOnly() != want || get() != want {
			t.Fatalf("after POST readonly=%v: response=%v server=%v", want, body["readonly"], s.ReadOnly())
		}
	}
}

func TestHandleReadOnlyEndpointRejectsBadInput(t *testing.T) {
	s := newSetupServer(t)
	s.SetReadOnly(true)
	for _, body := range []string{`not json`, `{}`, `{"readonly":"no"}`} {
		rr := httptest.NewRecorder()
		s.handleReadOnly(rr, httptest.NewRequest(http.MethodPost, "/api/readonly", strings.NewReader(body)))
		if rr.Code != http.StatusBadRequest {
			t.Errorf("body %q: status = %d, want 400", body, rr.Code)
		}
		if !s.ReadOnly() {
			t.Errorf("body %q flipped server out of read-only mode", body)
		}
	}
	rr := httptest.NewRecorder()
	s.handleReadOnly(rr, httptest.NewRequest(http.MethodPut, "/api/readonly", nil))
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("PUT status = %d, want 405", rr.Code)
	}
}

func TestMutatingHTTPHandlersRejectedInReadOnlyMode(t *testing.T) {
	s, ts := newReadOnlyTestServer(t)
	s.SetReadOnly(true)
	cases := []struct {
		method, path, body string
	}{
		{http.MethodPost, "/api/file/upload?context=c&namespace=ns&pod=p&path=/tmp/x", "data"},
		{http.MethodPost, "/api/file/mkdir?context=c&namespace=ns&pod=p&path=/tmp/d", ""},
		{http.MethodPost, "/api/nodes/debug", `{"context":"c","node":"n1"}`},
		{http.MethodDelete, "/api/nodes/debug/delete?context=c&pod=truss-node-debug-x&namespace=default", ""},
		{http.MethodGet, "/ws/exec?context=c&namespace=ns&pod=p&container=app", ""},
	}
	for _, tc := range cases {
		req, err := http.NewRequest(tc.method, ts.URL+tc.path, strings.NewReader(tc.body))
		if err != nil {
			t.Fatal(err)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", tc.method, tc.path, err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Errorf("%s %s: status = %d, want 403", tc.method, tc.path, resp.StatusCode)
			continue
		}
		var m map[string]string
		if err := json.Unmarshal(body, &m); err != nil || m["error"] != readOnlyMessage {
			t.Errorf("%s %s: body = %s, want error %q", tc.method, tc.path, body, readOnlyMessage)
		}
	}

	// In write mode the read-only gate no longer applies; the handlers fail
	// later for other reasons (unknown context), never with the RO error.
	s.SetReadOnly(false)
	for _, tc := range cases {
		req, _ := http.NewRequest(tc.method, ts.URL+tc.path, strings.NewReader(tc.body))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", tc.method, tc.path, err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if strings.Contains(string(body), readOnlyMessage) {
			t.Errorf("%s %s in write mode still rejected as read-only: %s", tc.method, tc.path, body)
		}
	}
}
