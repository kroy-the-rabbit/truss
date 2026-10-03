package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"connectrpc.com/connect"

	"github.com/kroy/truss/backend/api/gen/go/truss/v1/trussv1connect"
)

// readOnlyMessage is the error text returned whenever a mutating request is
// rejected because the daemon is in read-only mode. The frontend matches on it.
const readOnlyMessage = "read-only mode is enabled"

// mutatingProcedures lists every Connect procedure that changes cluster state.
// These are rejected while the daemon is in read-only mode. Any new mutating
// RPC must be added here.
var mutatingProcedures = map[string]struct{}{
	trussv1connect.ResourcesServiceDeleteResourceProcedure:  {},
	trussv1connect.ResourcesServiceScaleResourceProcedure:   {},
	trussv1connect.ResourcesServiceRestartResourceProcedure: {},
	trussv1connect.ResourcesServiceCordonNodeProcedure:      {},
	trussv1connect.ResourcesServiceUncordonNodeProcedure:    {},
	trussv1connect.ResourcesServiceDrainNodeProcedure:       {},
	trussv1connect.ResourcesServiceTriggerCronJobProcedure:  {},
	trussv1connect.YamlServiceApplyYamlProcedure:            {},
	trussv1connect.HelmServiceUninstallReleaseProcedure:     {},
	trussv1connect.HelmServiceRollbackReleaseProcedure:      {},
	trussv1connect.HelmServiceUpgradeReleaseProcedure:       {},
}

// isMutatingProcedure reports whether the Connect procedure mutates cluster state.
func isMutatingProcedure(procedure string) bool {
	_, ok := mutatingProcedures[procedure]
	return ok
}

// ReadOnly reports whether the daemon currently rejects mutating requests.
// The zero value of Server is read-only (fail closed).
func (s *Server) ReadOnly() bool {
	return !s.writeEnabled.Load()
}

// SetReadOnly switches the daemon between read-only and write mode.
func (s *Server) SetReadOnly(readOnly bool) {
	s.writeEnabled.Store(!readOnly)
}

func readOnlyConnectError() *connect.Error {
	return connect.NewError(connect.CodePermissionDenied, errors.New(readOnlyMessage))
}

// readOnlyInterceptor rejects mutating Connect procedures while in read-only mode.
type readOnlyInterceptor struct {
	s *Server
}

func (i readOnlyInterceptor) blocked(procedure string) bool {
	return i.s.ReadOnly() && isMutatingProcedure(procedure)
}

func (i readOnlyInterceptor) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		if i.blocked(req.Spec().Procedure) {
			return nil, readOnlyConnectError()
		}
		return next(ctx, req)
	}
}

func (i readOnlyInterceptor) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return next
}

func (i readOnlyInterceptor) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return func(ctx context.Context, conn connect.StreamingHandlerConn) error {
		if i.blocked(conn.Spec().Procedure) {
			return readOnlyConnectError()
		}
		return next(ctx, conn)
	}
}

// rejectIfReadOnly writes a 403 JSON error and returns true when the daemon is
// in read-only mode. HTTP handlers that mutate cluster state call it first.
func (s *Server) rejectIfReadOnly(w http.ResponseWriter) bool {
	if !s.ReadOnly() {
		return false
	}
	writeJSON(w, http.StatusForbidden, map[string]string{"error": readOnlyMessage})
	return true
}

// handleReadOnly reports (GET) or sets (POST) the daemon's read-only mode.
// GET  /api/readonly            -> {"readonly": bool}
// POST /api/readonly {"readonly": bool} -> {"readonly": bool}
func (s *Server) handleReadOnly(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]bool{"readonly": s.ReadOnly()})
	case http.MethodPost:
		var body struct {
			ReadOnly *bool `json:"readonly"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ReadOnly == nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body: readonly (bool) is required"})
			return
		}
		s.SetReadOnly(*body.ReadOnly)
		writeJSON(w, http.StatusOK, map[string]bool{"readonly": s.ReadOnly()})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}
