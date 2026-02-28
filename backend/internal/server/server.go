package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"
	"github.com/kroy/truss/backend/internal/auth"
	"github.com/kroy/truss/backend/internal/contextstore"
	disc "github.com/kroy/truss/backend/internal/discovery"
	helmclient "github.com/kroy/truss/backend/internal/helm"
	"github.com/kroy/truss/backend/internal/kube"
	"github.com/kroy/truss/backend/internal/summarizer"
	"github.com/kroy/truss/backend/internal/watchcache"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"
	jsonpatch "gopkg.in/evanphx/json-patch.v4"
	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/tools/remotecommand"
	"nhooyr.io/websocket"
	"sigs.k8s.io/yaml"

	pb "github.com/kroy/truss/backend/api/gen/go/truss/v1"
	"github.com/kroy/truss/backend/api/gen/go/truss/v1/trussv1connect"
)

// Server holds all dependencies for the RPC server.
type Server struct {
	kubeMgr        *kube.Manager
	store          *contextstore.Store
	discoveryCache *disc.Cache
	version        string
	lifecycleMu    sync.Mutex
	httpServer     *http.Server
	listener       net.Listener
	searchMu       sync.RWMutex
	searchIndexes  map[string]*searchIndexState
	watchCache     *watchcache.Manager
}

// New creates a new Server.
func New(kubeMgr *kube.Manager, store *contextstore.Store, version string) *Server {
	return &Server{
		kubeMgr:        kubeMgr,
		store:          store,
		discoveryCache: disc.NewCache(),
		version:        version,
		searchIndexes:  make(map[string]*searchIndexState),
		watchCache:     watchcache.New(),
	}
}

// Start starts the HTTP server on a random localhost port. Returns the port and any error.
func (s *Server) Start(token string) (int, error) {
	mux := http.NewServeMux()

	// Register Connect services.
	mux.Handle(trussv1connect.NewHealthServiceHandler(s))
	mux.Handle(trussv1connect.NewContextsServiceHandler(s))
	mux.Handle(trussv1connect.NewDiscoveryServiceHandler(s))
	mux.Handle(trussv1connect.NewResourcesServiceHandler(s))
	mux.Handle(trussv1connect.NewYamlServiceHandler(s))
	mux.Handle(trussv1connect.NewHelmServiceHandler(s))
	mux.Handle(trussv1connect.NewOverviewServiceHandler(s))

	// Register WebSocket exec handler.
	mux.HandleFunc("/ws/exec", s.handleExecWS(token))
	mux.HandleFunc("/ws/watch", s.handleWatchWS(token))

	// Register file transfer REST endpoints.
	mux.HandleFunc("/api/file/list", s.handleFileList())
	mux.HandleFunc("/api/file/download", s.handleFileDownload())
	mux.HandleFunc("/api/file/upload", s.handleFileUpload())
	mux.HandleFunc("/api/file/mkdir", s.handleFileMkdir())

	// Register setup/context management REST endpoints.
	mux.HandleFunc("/api/setup-status", s.handleSetupStatus)
	mux.HandleFunc("/api/setup/initialize", s.handleSetupInitialize)
	mux.HandleFunc("/api/setup/unlock", s.handleSetupUnlock)
	mux.HandleFunc("/api/setup/lock", s.handleSetupLock)
	mux.HandleFunc("/api/setup/preferences", s.handleSetupPreferences)
	mux.HandleFunc("/api/setup/preferences/auto-lock", s.handleSetupAutoLockSet)
	mux.HandleFunc("/api/setup/preferences/never-confirm-bypass", s.handleSetupNeverConfirmBypassSet)
	mux.HandleFunc("/api/context-preflight", s.handleContextPreflight)
	mux.HandleFunc("/api/setup/reset", s.handleSetupReset)
	mux.HandleFunc("/api/gpg-keys", s.handleGPGKeys)
	mux.HandleFunc("/api/kubeconfig-contexts", s.handleKubeconfigContexts)
	mux.HandleFunc("/api/contexts/import", s.handleContextsImport)
	mux.HandleFunc("/api/contexts/delete", s.handleContextsDelete)
	mux.HandleFunc("/api/profiles", s.handleProfilesList)
	mux.HandleFunc("/api/profiles/create", s.handleProfilesCreate)
	mux.HandleFunc("/api/profiles/rename", s.handleProfilesRename)
	mux.HandleFunc("/api/profiles/delete", s.handleProfilesDelete)
	mux.HandleFunc("/api/profiles/set-active", s.handleProfilesSetActive)
	mux.HandleFunc("/api/profiles/set-color", s.handleProfilesSetColor)
	mux.HandleFunc("/api/plugins/secure-storage/get", s.handlePluginSecureStorageGet)
	mux.HandleFunc("/api/plugins/secure-storage/set", s.handlePluginSecureStorageSet)
	mux.HandleFunc("/api/plugins/secure-storage/delete", s.handlePluginSecureStorageDelete)
	mux.HandleFunc("/api/search/resources", s.handleSearchResources)

	// Register metrics/observability REST endpoints.
	mux.HandleFunc("/api/metrics/prometheus/discover", s.handleMetricsDiscover)
	mux.HandleFunc("/api/metrics/prometheus/query_range", s.handleMetricsQueryRange)
	mux.HandleFunc("/api/metrics/prometheus/query", s.handleMetricsQueryInstant)
	mux.HandleFunc("/api/metrics/prometheus/url", s.handleMetricsPrometheusURL)

	// Node debug pod endpoints.
	mux.HandleFunc("/api/nodes/debug", s.handleNodeDebug)
	mux.HandleFunc("/api/nodes/debug/delete", s.handleNodeDebugDelete)

	// Wrap with auth middleware.
	handler := auth.Middleware(token)(mux)

	// Enable h2c (HTTP/2 without TLS) for Connect, but bypass for WebSocket upgrades.
	h2cInner := h2c.NewHandler(handler, &http2.Server{})
	h2cHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// WebSocket upgrades must stay on HTTP/1.1 — don't route through h2c.
		if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			handler.ServeHTTP(w, r)
			return
		}
		h2cInner.ServeHTTP(w, r)
	})

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, fmt.Errorf("listening: %w", err)
	}

	port := listener.Addr().(*net.TCPAddr).Port

	// Warm the search index and watch cache asynchronously for the current active context.
	if ctx := s.kubeMgr.ActiveContext(); ctx != "" {
		s.triggerSearchIndexRefresh(ctx)
		go func() {
			cs, err := s.kubeMgr.GetClientSet(ctx)
			if err == nil {
				s.ensureWatchCache(ctx, cs)
			}
		}()
	}

	httpServer := &http.Server{Handler: h2cHandler}
	s.lifecycleMu.Lock()
	s.httpServer = httpServer
	s.listener = listener
	s.lifecycleMu.Unlock()

	go func() {
		if err := httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			fmt.Printf("server error: %v\n", err)
		}
	}()

	return port, nil
}

// Stop gracefully stops the HTTP server and informer/watch resources.
func (s *Server) Stop(ctx context.Context) error {
	s.lifecycleMu.Lock()
	httpServer := s.httpServer
	s.httpServer = nil
	s.listener = nil
	s.lifecycleMu.Unlock()

	s.watchCache.StopAll()

	if httpServer == nil {
		return nil
	}
	if ctx == nil {
		return httpServer.Close()
	}
	return httpServer.Shutdown(ctx)
}

// resolveContext returns the context to use (falls back to active context).
func (s *Server) resolveContext(ctx string) string {
	if ctx == "" {
		return s.kubeMgr.ActiveContext()
	}
	return ctx
}

// ensureWatchCache discovers GVRs and starts informers for a context. Idempotent.
func (s *Server) ensureWatchCache(ctxName string, cs *kube.ClientSet) {
	resources, err := s.discoveryCache.Discover(ctxName, cs.Discovery, false)
	if err != nil || len(resources) == 0 {
		return
	}
	s.watchCache.EnsureStarted(ctxName, cs.Dynamic, resources)
}

// --- HealthService ---

func (s *Server) Ping(
	_ context.Context,
	_ *connect.Request[pb.PingRequest],
) (*connect.Response[pb.PingResponse], error) {
	return connect.NewResponse(&pb.PingResponse{
		Status:  "pong",
		Version: s.version,
	}), nil
}

// --- ContextsService ---

func (s *Server) ListContexts(
	_ context.Context,
	_ *connect.Request[pb.ListContextsRequest],
) (*connect.Response[pb.ListContextsResponse], error) {
	activeCtx := s.kubeMgr.ActiveContext()
	var contexts []*pb.Context
	for _, name := range s.kubeMgr.ContextNames() {
		kubeCtx, _ := s.kubeMgr.GetContext(name)
		contexts = append(contexts, &pb.Context{
			Name:     name,
			Cluster:  kubeCtx.Cluster,
			User:     kubeCtx.AuthInfo,
			IsActive: name == activeCtx,
		})
	}
	sort.Slice(contexts, func(i, j int) bool { return contexts[i].Name < contexts[j].Name })
	return connect.NewResponse(&pb.ListContextsResponse{Contexts: contexts}), nil
}

func (s *Server) SetActiveContext(
	_ context.Context,
	req *connect.Request[pb.SetActiveContextRequest],
) (*connect.Response[pb.SetActiveContextResponse], error) {
	name := req.Msg.Name
	if err := s.kubeMgr.SetActiveContext(name); err != nil {
		return nil, connect.NewError(connect.CodeNotFound, err)
	}
	s.triggerSearchIndexRefresh(name)
	kubeCtx, _ := s.kubeMgr.GetContext(name)
	return connect.NewResponse(&pb.SetActiveContextResponse{
		Context: &pb.Context{
			Name:     name,
			Cluster:  kubeCtx.Cluster,
			User:     kubeCtx.AuthInfo,
			IsActive: true,
		},
	}), nil
}

func (s *Server) ListNamespaces(
	ctx context.Context,
	req *connect.Request[pb.ListNamespacesRequest],
) (*connect.Response[pb.ListNamespacesResponse], error) {
	ctxName := s.resolveContext(req.Msg.Context)
	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	nsList, err := cs.Clientset.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("listing namespaces: %w", err))
	}

	var namespaces []*pb.Namespace
	for _, ns := range nsList.Items {
		namespaces = append(namespaces, &pb.Namespace{
			Name:   ns.Name,
			Status: string(ns.Status.Phase),
		})
	}
	return connect.NewResponse(&pb.ListNamespacesResponse{Namespaces: namespaces}), nil
}

// --- DiscoveryService ---

func (s *Server) ListResourceKinds(
	_ context.Context,
	req *connect.Request[pb.ListResourceKindsRequest],
) (*connect.Response[pb.ListResourceKindsResponse], error) {
	ctxName := s.resolveContext(req.Msg.Context)
	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	resources, err := s.discoveryCache.Discover(ctxName, cs.Discovery, false)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("discovering resources: %w", err))
	}

	groupMap := make(map[string]*pb.ResourceGroup)
	for _, r := range resources {
		g, ok := groupMap[r.Category]
		if !ok {
			g = &pb.ResourceGroup{Category: r.Category}
			groupMap[r.Category] = g
		}
		g.Kinds = append(g.Kinds, &pb.ResourceKind{
			Kind:       r.Kind,
			Group:      r.Group,
			Version:    r.Version,
			Resource:   r.Resource,
			Namespaced: r.Namespaced,
		})
	}

	var groups []*pb.ResourceGroup
	for _, g := range groupMap {
		groups = append(groups, g)
	}
	sort.Slice(groups, func(i, j int) bool {
		return disc.CategoryOrder(groups[i].Category) < disc.CategoryOrder(groups[j].Category)
	})
	return connect.NewResponse(&pb.ListResourceKindsResponse{Groups: groups}), nil
}

// resolveNamespace returns the namespace to use for a dynamic client call.
// For cluster-scoped resources, it always returns "" regardless of what the
// caller requested, preventing invalid namespaced queries against cluster resources.
func (s *Server) resolveNamespace(contextName, group, resource, requestedNS string) string {
	if requestedNS == "" {
		return ""
	}
	if !s.discoveryCache.IsNamespaced(contextName, group, resource) {
		return ""
	}
	return requestedNS
}

// --- ResourcesService ---

func (s *Server) ListResources(
	ctx context.Context,
	req *connect.Request[pb.ListResourcesRequest],
) (*connect.Response[pb.ListResourcesResponse], error) {
	ctxName := s.resolveContext(req.Msg.Context)
	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	gvr := schema.GroupVersionResource{
		Group:    req.Msg.Gvr.Group,
		Version:  req.Msg.Gvr.Version,
		Resource: req.Msg.Gvr.Resource,
	}

	ns := s.resolveNamespace(ctxName, gvr.Group, gvr.Resource, req.Msg.Namespace)

	// Try cache first; fall back to direct API call while the cache warms.
	var items []unstructured.Unstructured
	if cachedItems, synced := s.watchCache.ListAll(ctxName, gvr, ns); synced {
		items = cachedItems
	} else {
		var list *unstructured.UnstructuredList
		if ns == "" {
			list, err = cs.Dynamic.Resource(gvr).List(ctx, metav1.ListOptions{})
		} else {
			list, err = cs.Dynamic.Resource(gvr).Namespace(ns).List(ctx, metav1.ListOptions{})
		}
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("listing resources: %w", err))
		}
		items = list.Items
		// Ensure informers are running so the next call will be served from cache.
		go s.ensureWatchCache(ctxName, cs)
	}

	// Apply name filter if provided.
	if req.Msg.Filter != "" {
		filter := strings.ToLower(req.Msg.Filter)
		var filtered []unstructured.Unstructured
		for _, item := range items {
			if strings.Contains(strings.ToLower(item.GetName()), filter) {
				filtered = append(filtered, item)
			}
		}
		items = filtered
	}

	// Deterministic ordering is required for tokenized pagination.
	sortField := strings.ToLower(strings.TrimSpace(req.Msg.SortField))
	sort.SliceStable(items, func(i, j int) bool {
		if req.Msg.SortDesc {
			return resourceSortLess(items[j], items[i], sortField)
		}
		return resourceSortLess(items[i], items[j], sortField)
	})

	totalCount := int32(len(items))

	start, err := parsePageToken(req.Msg.PageToken)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid page_token: %w", err))
	}
	if start < 0 {
		start = 0
	}
	if start > len(items) {
		start = len(items)
	}

	// Apply page size.
	limit := int(req.Msg.Limit)
	if limit <= 0 {
		limit = 200
	}
	if limit > 1000 {
		limit = 1000
	}
	end := start + limit
	if end > len(items) {
		end = len(items)
	}
	pageItems := items[start:end]
	nextPageToken := ""
	if end < len(items) {
		nextPageToken = strconv.Itoa(end)
	}

	var resources []*pb.Resource
	for _, item := range pageItems {
		kind := item.GetKind()
		summaryFields := summarizer.Summarize(kind, &item)
		conditions := summarizer.ExtractConditions(&item)

		res := convertToProto(&item, kind, summaryFields, conditions)
		resources = append(resources, res)
	}

	return connect.NewResponse(&pb.ListResourcesResponse{
		Resources:     resources,
		NextPageToken: nextPageToken,
		TotalCount:    totalCount,
	}), nil
}

func parsePageToken(token string) (int, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return 0, nil
	}
	v, err := strconv.Atoi(token)
	if err != nil || v < 0 {
		return 0, errors.New("must be a non-negative integer offset")
	}
	return v, nil
}

func resourceSortLess(a, b unstructured.Unstructured, sortField string) bool {
	av := resourceSortFieldValue(a, sortField)
	bv := resourceSortFieldValue(b, sortField)
	if av == bv {
		return strings.ToLower(a.GetName()) < strings.ToLower(b.GetName())
	}
	return av < bv
}

func resourceSortFieldValue(item unstructured.Unstructured, sortField string) string {
	switch sortField {
	case "namespace":
		return strings.ToLower(item.GetNamespace()) + "\x00" + strings.ToLower(item.GetName())
	case "creation_timestamp", "created", "age":
		return item.GetCreationTimestamp().UTC().Format(time.RFC3339Nano) + "\x00" + strings.ToLower(item.GetName())
	case "kind":
		return strings.ToLower(item.GetKind()) + "\x00" + strings.ToLower(item.GetName())
	case "name", "":
		fallthrough
	default:
		return strings.ToLower(item.GetName())
	}
}

func (s *Server) GetResource(
	ctx context.Context,
	req *connect.Request[pb.GetResourceRequest],
) (*connect.Response[pb.GetResourceResponse], error) {
	ctxName := s.resolveContext(req.Msg.Context)
	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	gvr := schema.GroupVersionResource{
		Group:    req.Msg.Gvr.Group,
		Version:  req.Msg.Gvr.Version,
		Resource: req.Msg.Gvr.Resource,
	}

	ns := s.resolveNamespace(ctxName, gvr.Group, gvr.Resource, req.Msg.Namespace)
	var obj *unstructured.Unstructured
	if ns == "" {
		obj, err = cs.Dynamic.Resource(gvr).Get(ctx, req.Msg.Name, metav1.GetOptions{})
	} else {
		obj, err = cs.Dynamic.Resource(gvr).Namespace(ns).Get(ctx, req.Msg.Name, metav1.GetOptions{})
	}
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("getting resource: %w", err))
	}

	kind := obj.GetKind()
	summaryFields := summarizer.Summarize(kind, obj)
	conditions := summarizer.ExtractConditions(obj)

	return connect.NewResponse(&pb.GetResourceResponse{
		Resource: convertToProto(obj, kind, summaryFields, conditions),
	}), nil
}

func (s *Server) DeleteResource(
	ctx context.Context,
	req *connect.Request[pb.DeleteResourceRequest],
) (*connect.Response[pb.DeleteResourceResponse], error) {
	ctxName := s.resolveContext(req.Msg.Context)
	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	gvr := schema.GroupVersionResource{
		Group:    req.Msg.Gvr.Group,
		Version:  req.Msg.Gvr.Version,
		Resource: req.Msg.Gvr.Resource,
	}

	ns := s.resolveNamespace(ctxName, gvr.Group, gvr.Resource, req.Msg.Namespace)
	deleteOpts := metav1.DeleteOptions{}
	if req.Msg.GracePeriodSeconds == 0 {
		zero := int64(0)
		deleteOpts.GracePeriodSeconds = &zero
	}
	if ns == "" {
		err = cs.Dynamic.Resource(gvr).Delete(ctx, req.Msg.Name, deleteOpts)
	} else {
		err = cs.Dynamic.Resource(gvr).Namespace(ns).Delete(ctx, req.Msg.Name, deleteOpts)
	}
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("deleting resource: %w", err))
	}

	return connect.NewResponse(&pb.DeleteResourceResponse{
		Success: true,
		Message: fmt.Sprintf("deleted %s/%s", req.Msg.Gvr.Resource, req.Msg.Name),
	}), nil
}

func (s *Server) ScaleResource(
	ctx context.Context,
	req *connect.Request[pb.ScaleResourceRequest],
) (*connect.Response[pb.ScaleResourceResponse], error) {
	ctxName := s.resolveContext(req.Msg.Context)
	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	gvr := schema.GroupVersionResource{
		Group:    req.Msg.Gvr.Group,
		Version:  req.Msg.Gvr.Version,
		Resource: req.Msg.Gvr.Resource,
	}

	ns := req.Msg.Namespace
	name := req.Msg.Name
	replicas := req.Msg.Replicas

	// Get current state to read previous replicas.
	current, err := cs.Dynamic.Resource(gvr).Namespace(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("getting resource: %w", err))
	}
	prevReplicas, _, _ := unstructured.NestedInt64(current.Object, "spec", "replicas")

	patch := []byte(fmt.Sprintf(`{"spec":{"replicas":%d}}`, replicas))
	_, err = cs.Dynamic.Resource(gvr).Namespace(ns).Patch(ctx, name, types.MergePatchType, patch, metav1.PatchOptions{})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("scaling resource: %w", err))
	}

	return connect.NewResponse(&pb.ScaleResourceResponse{
		Success:          true,
		Message:          fmt.Sprintf("scaled %s/%s from %d to %d replicas", req.Msg.Gvr.Resource, name, prevReplicas, replicas),
		PreviousReplicas: int32(prevReplicas),
		CurrentReplicas:  replicas,
	}), nil
}

func (s *Server) RestartResource(
	ctx context.Context,
	req *connect.Request[pb.RestartResourceRequest],
) (*connect.Response[pb.RestartResourceResponse], error) {
	ctxName := s.resolveContext(req.Msg.Context)
	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	gvr := schema.GroupVersionResource{
		Group:    req.Msg.Gvr.Group,
		Version:  req.Msg.Gvr.Version,
		Resource: req.Msg.Gvr.Resource,
	}

	ns := req.Msg.Namespace
	name := req.Msg.Name

	patch := []byte(fmt.Sprintf(
		`{"spec":{"template":{"metadata":{"annotations":{"kubectl.kubernetes.io/restartedAt":"%s"}}}}}`,
		time.Now().Format(time.RFC3339),
	))
	_, err = cs.Dynamic.Resource(gvr).Namespace(ns).Patch(ctx, name, types.MergePatchType, patch, metav1.PatchOptions{})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("restarting resource: %w", err))
	}

	return connect.NewResponse(&pb.RestartResourceResponse{
		Success: true,
		Message: fmt.Sprintf("rollout restart triggered for %s/%s", req.Msg.Gvr.Resource, name),
	}), nil
}

func (s *Server) GetResourceCounts(
	ctx context.Context,
	req *connect.Request[pb.GetResourceCountsRequest],
) (*connect.Response[pb.GetResourceCountsResponse], error) {
	ctxName := s.resolveContext(req.Msg.Context)
	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	ns := req.Msg.Namespace
	gvrs := req.Msg.Gvrs

	type countResult struct {
		index int
		count int32
		err   error
	}

	// Pass 1: serve hot GVRs from the watch cache instantly.
	counts := make([]*pb.ResourceCount, len(gvrs))
	type coldEntry struct {
		idx int
		gvr schema.GroupVersionResource
		ns  string
	}
	var cold []coldEntry

	for i, g := range gvrs {
		gvr := schema.GroupVersionResource{Group: g.Group, Version: g.Version, Resource: g.Resource}
		resolvedNS := s.resolveNamespace(ctxName, gvr.Group, gvr.Resource, ns)
		if count, synced := s.watchCache.Len(ctxName, gvr, resolvedNS); synced {
			counts[i] = &pb.ResourceCount{Gvr: gvrs[i], Count: int32(count)}
		} else {
			cold = append(cold, coldEntry{i, gvr, resolvedNS})
		}
	}

	// Pass 2: parallel API calls only for cache-cold GVRs.
	if len(cold) > 0 {
		results := make(chan countResult, len(cold))
		var wg sync.WaitGroup
		sem := make(chan struct{}, 5) // limit to 5 concurrent API calls

		for _, f := range cold {
			wg.Add(1)
			go func(e coldEntry) {
				defer wg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()
				var list *unstructured.UnstructuredList
				var listErr error
				if e.ns == "" {
					list, listErr = cs.Dynamic.Resource(e.gvr).List(ctx, metav1.ListOptions{})
				} else {
					list, listErr = cs.Dynamic.Resource(e.gvr).Namespace(e.ns).List(ctx, metav1.ListOptions{})
				}
				if listErr != nil {
					results <- countResult{index: e.idx, count: 0, err: listErr}
					return
				}
				results <- countResult{index: e.idx, count: int32(len(list.Items))}
			}(f)
		}

		go func() {
			wg.Wait()
			close(results)
		}()

		for r := range results {
			counts[r.index] = &pb.ResourceCount{Gvr: gvrs[r.index], Count: r.count}
		}
	}

	return connect.NewResponse(&pb.GetResourceCountsResponse{Counts: counts}), nil
}

// --- ResourcesService: GetOwnedPods ---

func (s *Server) GetOwnedPods(
	ctx context.Context,
	req *connect.Request[pb.GetOwnedPodsRequest],
) (*connect.Response[pb.GetOwnedPodsResponse], error) {
	ctxName := s.resolveContext(req.Msg.Context)
	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	// Resolve kind → GVR via discovery cache.
	resources, err := s.discoveryCache.Discover(ctxName, cs.Discovery, false)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("discovering resources: %w", err))
	}

	var gvr schema.GroupVersionResource
	found := false
	for _, r := range resources {
		if r.Kind == req.Msg.Kind {
			gvr = schema.GroupVersionResource{
				Group:    r.Group,
				Version:  r.Version,
				Resource: r.Resource,
			}
			found = true
			break
		}
	}
	if !found {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("unknown kind: %s", req.Msg.Kind))
	}

	// Get the workload object.
	obj, err := cs.Dynamic.Resource(gvr).Namespace(req.Msg.Namespace).Get(ctx, req.Msg.Name, metav1.GetOptions{})
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("getting resource: %w", err))
	}

	// Extract spec.selector.matchLabels.
	matchLabels, _, err := unstructured.NestedStringMap(obj.Object, "spec", "selector", "matchLabels")
	if err != nil || len(matchLabels) == 0 {
		return connect.NewResponse(&pb.GetOwnedPodsResponse{}), nil
	}

	// Build label selector string.
	var parts []string
	for k, v := range matchLabels {
		parts = append(parts, k+"="+v)
	}
	sort.Strings(parts)
	selectorStr := strings.Join(parts, ",")

	// List pods in namespace with label selector.
	podGVR := schema.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"}
	podList, err := cs.Dynamic.Resource(podGVR).Namespace(req.Msg.Namespace).List(ctx, metav1.ListOptions{
		LabelSelector: selectorStr,
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("listing pods: %w", err))
	}

	var pods []*pb.Resource
	for _, item := range podList.Items {
		kind := item.GetKind()
		if kind == "" {
			kind = "Pod"
		}
		summaryFields := summarizer.Summarize(kind, &item)
		conditions := summarizer.ExtractConditions(&item)
		pods = append(pods, convertToProto(&item, kind, summaryFields, conditions))
	}

	return connect.NewResponse(&pb.GetOwnedPodsResponse{Pods: pods}), nil
}

// --- YamlService ---

func (s *Server) GetYaml(
	ctx context.Context,
	req *connect.Request[pb.GetYamlRequest],
) (*connect.Response[pb.GetYamlResponse], error) {
	ctxName := s.resolveContext(req.Msg.Context)
	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	gvr := schema.GroupVersionResource{
		Group:    req.Msg.Gvr.Group,
		Version:  req.Msg.Gvr.Version,
		Resource: req.Msg.Gvr.Resource,
	}

	ns := s.resolveNamespace(ctxName, gvr.Group, gvr.Resource, req.Msg.Namespace)
	var obj *unstructured.Unstructured
	if ns == "" {
		obj, err = cs.Dynamic.Resource(gvr).Get(ctx, req.Msg.Name, metav1.GetOptions{})
	} else {
		obj, err = cs.Dynamic.Resource(gvr).Namespace(ns).Get(ctx, req.Msg.Name, metav1.GetOptions{})
	}
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("getting resource: %w", err))
	}

	// Remove managedFields for cleaner YAML output.
	obj.SetManagedFields(nil)

	yamlBytes, err := yaml.Marshal(obj.Object)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("marshaling yaml: %w", err))
	}

	return connect.NewResponse(&pb.GetYamlResponse{Yaml: string(yamlBytes)}), nil
}

func (s *Server) ApplyYaml(
	ctx context.Context,
	req *connect.Request[pb.ApplyYamlRequest],
) (*connect.Response[pb.ApplyYamlResponse], error) {
	ctxName := s.resolveContext(req.Msg.Context)
	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	var obj unstructured.Unstructured
	if err := yaml.Unmarshal([]byte(req.Msg.Yaml), &obj.Object); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("parsing yaml: %w", err))
	}

	gvk := obj.GroupVersionKind()
	// We need to find the resource name (plural) for this GVK.
	resources, err := s.discoveryCache.Discover(ctxName, cs.Discovery, false)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	var gvr schema.GroupVersionResource
	found := false
	for _, r := range resources {
		if r.Kind == gvk.Kind && r.Group == gvk.Group {
			gvr = schema.GroupVersionResource{
				Group:    r.Group,
				Version:  r.Version,
				Resource: r.Resource,
			}
			found = true
			break
		}
	}
	if !found {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("unknown resource kind: %s", gvk.Kind))
	}

	fieldManager := req.Msg.FieldManager
	if fieldManager == "" {
		fieldManager = "truss"
	}

	ns := obj.GetNamespace()
	if req.Msg.Namespace != "" {
		ns = req.Msg.Namespace
	}

	data, err := yaml.Marshal(obj.Object)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("marshaling: %w", err))
	}

	var result *unstructured.Unstructured
	if ns == "" {
		result, err = cs.Dynamic.Resource(gvr).Patch(
			ctx, obj.GetName(), types.ApplyPatchType, data,
			metav1.PatchOptions{FieldManager: fieldManager, Force: boolPtr(true)},
		)
	} else {
		result, err = cs.Dynamic.Resource(gvr).Namespace(ns).Patch(
			ctx, obj.GetName(), types.ApplyPatchType, data,
			metav1.PatchOptions{FieldManager: fieldManager, Force: boolPtr(true)},
		)
	}
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("applying: %w", err))
	}

	result.SetManagedFields(nil)
	resultYaml, _ := yaml.Marshal(result.Object)

	return connect.NewResponse(&pb.ApplyYamlResponse{
		Success:       true,
		Message:       "applied successfully",
		ResultingYaml: string(resultYaml),
	}), nil
}

func (s *Server) DiffYaml(
	ctx context.Context,
	req *connect.Request[pb.DiffYamlRequest],
) (*connect.Response[pb.DiffYamlResponse], error) {
	ctxName := s.resolveContext(req.Msg.Context)
	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	gvr := schema.GroupVersionResource{
		Group:    req.Msg.Gvr.Group,
		Version:  req.Msg.Gvr.Version,
		Resource: req.Msg.Gvr.Resource,
	}

	ns := s.resolveNamespace(ctxName, gvr.Group, gvr.Resource, req.Msg.Namespace)
	var obj *unstructured.Unstructured
	if ns == "" {
		obj, err = cs.Dynamic.Resource(gvr).Get(ctx, req.Msg.Name, metav1.GetOptions{})
	} else {
		obj, err = cs.Dynamic.Resource(gvr).Namespace(ns).Get(ctx, req.Msg.Name, metav1.GetOptions{})
	}
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("getting resource: %w", err))
	}

	obj.SetManagedFields(nil)
	currentYaml, err := yaml.Marshal(obj.Object)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("marshaling: %w", err))
	}

	diff := computeDiff(string(currentYaml), req.Msg.ProposedYaml)

	return connect.NewResponse(&pb.DiffYamlResponse{Diff: diff}), nil
}

// computeDiff produces a semantic object-level diff as a JSON merge patch.
// If parsing fails, it falls back to a simple line-by-line diff.
func computeDiff(current, proposed string) string {
	currentJSON, errCurrent := normalizeYAMLForDiff(current)
	proposedJSON, errProposed := normalizeYAMLForDiff(proposed)
	if errCurrent == nil && errProposed == nil {
		patch, err := jsonpatch.CreateMergePatch(currentJSON, proposedJSON)
		if err == nil {
			var parsed any
			if err := json.Unmarshal(patch, &parsed); err == nil {
				pretty, err := json.MarshalIndent(parsed, "", "  ")
				if err == nil {
					return string(pretty)
				}
			}
			return string(patch)
		}
	}

	currentLines := strings.Split(current, "\n")
	proposedLines := strings.Split(proposed, "\n")
	var diff strings.Builder
	diff.WriteString("--- current\n")
	diff.WriteString("+++ proposed\n")
	maxLen := len(currentLines)
	if len(proposedLines) > maxLen {
		maxLen = len(proposedLines)
	}
	for i := 0; i < maxLen; i++ {
		var cl, pl string
		if i < len(currentLines) {
			cl = currentLines[i]
		}
		if i < len(proposedLines) {
			pl = proposedLines[i]
		}
		if cl != pl {
			if i < len(currentLines) {
				diff.WriteString("- " + cl + "\n")
			}
			if i < len(proposedLines) {
				diff.WriteString("+ " + pl + "\n")
			}
		} else {
			diff.WriteString("  " + cl + "\n")
		}
	}
	return diff.String()
}

func normalizeYAMLForDiff(in string) ([]byte, error) {
	var obj any
	if err := yaml.Unmarshal([]byte(in), &obj); err != nil {
		return nil, err
	}
	normalized := normalizeDiffValue(obj)
	return json.Marshal(normalized)
}

func normalizeDiffValue(v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, val := range x {
			out[k] = normalizeDiffValue(val)
		}
		return out
	case []any:
		out := make([]any, 0, len(x))
		for _, item := range x {
			out = append(out, normalizeDiffValue(item))
		}
		return out
	default:
		return v
	}
}

func convertToProto(obj *unstructured.Unstructured, kind string, summaryFields []summarizer.SummaryField, conditions []summarizer.Condition) *pb.Resource {
	labels := obj.GetLabels()
	if labels == nil {
		labels = make(map[string]string)
	}
	annotations := obj.GetAnnotations()
	if annotations == nil {
		annotations = make(map[string]string)
	}

	var pbSummary []*pb.SummaryField
	for _, f := range summaryFields {
		pbSummary = append(pbSummary, &pb.SummaryField{Key: f.Key, Value: f.Value})
	}

	var pbConditions []*pb.Condition
	for _, c := range conditions {
		pbConditions = append(pbConditions, &pb.Condition{
			Type:           c.Type,
			Status:         c.Status,
			Reason:         c.Reason,
			Message:        c.Message,
			LastTransition: c.LastTransition,
		})
	}

	return &pb.Resource{
		Metadata: &pb.ResourceMeta{
			Name:              obj.GetName(),
			Namespace:         obj.GetNamespace(),
			Uid:               string(obj.GetUID()),
			CreationTimestamp: obj.GetCreationTimestamp().Format("2006-01-02T15:04:05Z"),
			Labels:            labels,
			Annotations:       annotations,
		},
		Kind:       kind,
		ApiVersion: obj.GetAPIVersion(),
		Summary:    pbSummary,
		Conditions: pbConditions,
	}
}

func boolPtr(b bool) *bool { return &b }

func buildContainerInfo(name, image string, isInit bool, status corev1.ContainerStatus) *pb.ContainerInfo {
	info := &pb.ContainerInfo{
		Name:         name,
		Image:        image,
		IsInit:       isInit,
		Ready:        status.Ready,
		RestartCount: int32(status.RestartCount),
	}
	if status.State.Running != nil {
		info.State = "running"
		info.StartedAt = status.State.Running.StartedAt.Format("2006-01-02T15:04:05Z")
	} else if status.State.Waiting != nil {
		info.State = "waiting"
		info.Reason = status.State.Waiting.Reason
		info.Message = status.State.Waiting.Message
	} else if status.State.Terminated != nil {
		info.State = "terminated"
		info.Reason = status.State.Terminated.Reason
		info.Message = status.State.Terminated.Message
		if !status.State.Terminated.StartedAt.IsZero() {
			info.StartedAt = status.State.Terminated.StartedAt.Format("2006-01-02T15:04:05Z")
		}
		if !status.State.Terminated.FinishedAt.IsZero() {
			info.FinishedAt = status.State.Terminated.FinishedAt.Format("2006-01-02T15:04:05Z")
		}
	}
	return info
}

// --- ResourcesService: ListEvents ---

func (s *Server) ListEvents(
	ctx context.Context,
	req *connect.Request[pb.ListEventsRequest],
) (*connect.Response[pb.ListEventsResponse], error) {
	ctxName := s.resolveContext(req.Msg.Context)
	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	ns := req.Msg.Namespace
	var eventList *corev1.EventList
	if ns == "" {
		eventList, err = cs.Clientset.CoreV1().Events("").List(ctx, metav1.ListOptions{})
	} else {
		eventList, err = cs.Clientset.CoreV1().Events(ns).List(ctx, metav1.ListOptions{})
	}
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("listing events: %w", err))
	}

	var events []*pb.EventItem
	for _, ev := range eventList.Items {
		// Filter by involvedObject if specified.
		if req.Msg.Kind != "" && ev.InvolvedObject.Kind != req.Msg.Kind {
			continue
		}
		if req.Msg.Name != "" && ev.InvolvedObject.Name != req.Msg.Name {
			continue
		}
		if req.Msg.Uid != "" && string(ev.InvolvedObject.UID) != req.Msg.Uid {
			continue
		}

		firstSeen := ""
		if !ev.FirstTimestamp.IsZero() {
			firstSeen = ev.FirstTimestamp.Format("2006-01-02T15:04:05Z")
		}
		lastSeen := ""
		if !ev.LastTimestamp.IsZero() {
			lastSeen = ev.LastTimestamp.Format("2006-01-02T15:04:05Z")
		}

		events = append(events, &pb.EventItem{
			Type:           ev.Type,
			Reason:         ev.Reason,
			Message:        ev.Message,
			Source:         ev.Source.Component,
			FirstSeen:      firstSeen,
			LastSeen:       lastSeen,
			Count:          ev.Count,
			InvolvedObject: ev.InvolvedObject.Kind + "/" + ev.InvolvedObject.Name,
		})
	}

	// Sort by lastSeen descending (most recent first).
	sort.Slice(events, func(i, j int) bool {
		return events[i].LastSeen > events[j].LastSeen
	})

	return connect.NewResponse(&pb.ListEventsResponse{Events: events}), nil
}

// --- ResourcesService: GetLogs ---

func (s *Server) GetLogs(
	ctx context.Context,
	req *connect.Request[pb.GetLogsRequest],
) (*connect.Response[pb.GetLogsResponse], error) {
	ctxName := s.resolveContext(req.Msg.Context)
	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	// List containers in the pod.
	pod, err := cs.Clientset.CoreV1().Pods(req.Msg.Namespace).Get(ctx, req.Msg.Pod, metav1.GetOptions{})
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("getting pod: %w", err))
	}

	var containers []string
	var containerInfos []*pb.ContainerInfo
	// Build status lookup maps.
	initStatusMap := make(map[string]corev1.ContainerStatus)
	for _, s := range pod.Status.InitContainerStatuses {
		initStatusMap[s.Name] = s
	}
	statusMap := make(map[string]corev1.ContainerStatus)
	for _, s := range pod.Status.ContainerStatuses {
		statusMap[s.Name] = s
	}

	for _, c := range pod.Spec.InitContainers {
		containers = append(containers, "init:"+c.Name)
		info := buildContainerInfo(c.Name, c.Image, true, initStatusMap[c.Name])
		containerInfos = append(containerInfos, info)
	}
	for _, c := range pod.Spec.Containers {
		containers = append(containers, c.Name)
		info := buildContainerInfo(c.Name, c.Image, false, statusMap[c.Name])
		containerInfos = append(containerInfos, info)
	}

	opts := &corev1.PodLogOptions{
		Timestamps: req.Msg.Timestamps,
		Previous:   req.Msg.Previous,
	}
	if req.Msg.Container != "" {
		opts.Container = req.Msg.Container
	}
	if req.Msg.TailLines > 0 {
		tl := int64(req.Msg.TailLines)
		opts.TailLines = &tl
	}
	if req.Msg.SinceSeconds != "" {
		sec, parseErr := strconv.ParseInt(req.Msg.SinceSeconds, 10, 64)
		if parseErr == nil && sec > 0 {
			opts.SinceSeconds = &sec
		}
	}

	logReq := cs.Clientset.CoreV1().Pods(req.Msg.Namespace).GetLogs(req.Msg.Pod, opts)
	stream, err := logReq.Stream(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("streaming logs: %w", err))
	}
	defer stream.Close()

	logBytes, err := io.ReadAll(io.LimitReader(stream, 5*1024*1024)) // 5MB limit
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("reading logs: %w", err))
	}

	return connect.NewResponse(&pb.GetLogsResponse{
		Logs:           string(logBytes),
		Containers:     containers,
		ContainerInfos: containerInfos,
		PodPhase:       string(pod.Status.Phase),
	}), nil
}

// --- ResourcesService: GetPodInfo ---

func (s *Server) GetPodInfo(
	ctx context.Context,
	req *connect.Request[pb.GetPodInfoRequest],
) (*connect.Response[pb.GetPodInfoResponse], error) {
	ctxName := s.resolveContext(req.Msg.Context)
	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	pod, err := cs.Clientset.CoreV1().Pods(req.Msg.Namespace).Get(ctx, req.Msg.Pod, metav1.GetOptions{})
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("getting pod: %w", err))
	}

	initStatusMap := make(map[string]corev1.ContainerStatus)
	for _, s := range pod.Status.InitContainerStatuses {
		initStatusMap[s.Name] = s
	}
	statusMap := make(map[string]corev1.ContainerStatus)
	for _, s := range pod.Status.ContainerStatuses {
		statusMap[s.Name] = s
	}

	var infos []*pb.ContainerInfo
	for _, c := range pod.Spec.InitContainers {
		infos = append(infos, buildContainerInfo(c.Name, c.Image, true, initStatusMap[c.Name]))
	}
	for _, c := range pod.Spec.Containers {
		infos = append(infos, buildContainerInfo(c.Name, c.Image, false, statusMap[c.Name]))
	}

	qos := string(pod.Status.QOSClass)

	return connect.NewResponse(&pb.GetPodInfoResponse{
		PodPhase:   string(pod.Status.Phase),
		PodIp:      pod.Status.PodIP,
		NodeName:   pod.Spec.NodeName,
		QosClass:   qos,
		Containers: infos,
	}), nil
}

// --- WebSocket Exec Handler ---

func isAllowedExecOrigin(origin string) bool {
	if origin == "" || origin == "null" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if strings.EqualFold(u.Scheme, "file") {
		return true
	}
	switch strings.ToLower(u.Hostname()) {
	case "127.0.0.1", "localhost", "::1":
		return true
	default:
		return false
	}
}

func (s *Server) handleExecWS(_ string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !isAllowedExecOrigin(r.Header.Get("Origin")) {
			http.Error(w, "forbidden origin", http.StatusForbidden)
			return
		}

		ctxName := r.URL.Query().Get("context")
		if ctxName == "" {
			ctxName = s.kubeMgr.ActiveContext()
		}
		namespace := r.URL.Query().Get("namespace")
		podName := r.URL.Query().Get("pod")
		container := r.URL.Query().Get("container")

		if podName == "" || namespace == "" {
			http.Error(w, "pod and namespace required", http.StatusBadRequest)
			return
		}

		cs, err := s.kubeMgr.GetClientSet(ctxName)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			InsecureSkipVerify: true, // origin is validated explicitly above
			Subprotocols:       []string{"truss-exec-v1"},
			CompressionMode:    websocket.CompressionNoContextTakeover,
		})
		if err != nil {
			return
		}

		wsCtx := r.Context()

		// Fast-fail unreachable clusters instead of hanging indefinitely on exec setup.
		preflightCtx, cancelPreflight := context.WithTimeout(wsCtx, 8*time.Second)
		_, preflightErr := cs.Clientset.CoreV1().Pods(namespace).Get(preflightCtx, podName, metav1.GetOptions{})
		cancelPreflight()
		if preflightErr != nil {
			msg := fmt.Sprintf("exec preflight failed: %v", preflightErr)
			_ = conn.Write(wsCtx, websocket.MessageText, []byte("\r\n["+msg+"]\r\n"))
			_ = conn.Close(websocket.StatusInternalError, "exec preflight failed")
			return
		}

		// Probe for an available shell first, then start one interactive stream.
		// This avoids shell-chain edge-cases that can surface as exit 127/1006.
		var cmd []string
		candidates := []string{"/bin/bash", "/bin/sh", "bash", "sh", "/busybox/sh"}
		for _, shellCmd := range candidates {
			probeCtx, cancelProbe := context.WithTimeout(wsCtx, 3*time.Second)
			_, probeErr := s.execInPod(probeCtx, cs, namespace, podName, container, []string{shellCmd, "-c", ":"})
			cancelProbe()
			if probeErr == nil {
				cmd = []string{shellCmd, "-i"}
				break
			}
		}
		if len(cmd) == 0 {
			msg := "exec failed: no supported shell found in container (tried /bin/bash, /bin/sh, bash, sh, /busybox/sh)"
			_ = conn.Write(wsCtx, websocket.MessageText, []byte("\r\n["+msg+"]\r\n"))
			_ = conn.Close(websocket.StatusInternalError, "no shell found")
			return
		}

		execErr := s.runExec(wsCtx, cs, namespace, podName, container, cmd, conn)
		if execErr == nil {
			_ = conn.Close(websocket.StatusNormalClosure, "")
			return
		}
		if errors.Is(execErr, context.Canceled) || websocket.CloseStatus(execErr) != -1 {
			_ = conn.Close(websocket.StatusNormalClosure, "")
			return
		}

		if execErr != nil {
			msg := fmt.Sprintf("exec failed: %v", execErr)
			_ = conn.Write(wsCtx, websocket.MessageText, []byte("\r\n["+msg+"]\r\n"))
			if len(msg) > 120 {
				msg = msg[:120]
			}
			_ = conn.Close(websocket.StatusInternalError, msg)
		}
	}
}

func (s *Server) handleWatchWS(_ string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !isAllowedExecOrigin(r.Header.Get("Origin")) {
			http.Error(w, "forbidden origin", http.StatusForbidden)
			return
		}

		ctxName := s.resolveContext(r.URL.Query().Get("context"))
		if ctxName == "" {
			http.Error(w, "context required", http.StatusBadRequest)
			return
		}
		nsFilter := strings.TrimSpace(r.URL.Query().Get("namespace"))

		cs, err := s.kubeMgr.GetClientSet(ctxName)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		// Best-effort ensure informers are running for this context.
		s.ensureWatchCache(ctxName, cs)

		ch, cancel, ok := s.watchCache.Subscribe(ctxName)
		if !ok {
			http.Error(w, "watch cache unavailable", http.StatusServiceUnavailable)
			return
		}
		defer cancel()

		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			InsecureSkipVerify: true,
			Subprotocols:       []string{"truss-watch-v1"},
			CompressionMode:    websocket.CompressionNoContextTakeover,
		})
		if err != nil {
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")

		wsCtx := r.Context()
		ping := time.NewTicker(20 * time.Second)
		defer ping.Stop()

		type watchMsg struct {
			Type string `json:"type"`
			watchcache.ResourceEvent
		}

		for {
			select {
			case <-wsCtx.Done():
				return
			case <-ping.C:
				if err := conn.Write(wsCtx, websocket.MessageText, []byte(`{"type":"ping"}`)); err != nil {
					return
				}
			case ev, ok := <-ch:
				if !ok {
					return
				}
				if nsFilter != "" && ev.Namespace != "" && ev.Namespace != nsFilter {
					continue
				}
				if nsFilter != "" && ev.Namespace == "" {
					// Keep cluster-scoped changes because they affect overview/counts.
				}
				msg, err := json.Marshal(watchMsg{
					Type:          "resource",
					ResourceEvent: ev,
				})
				if err != nil {
					continue
				}
				if err := conn.Write(wsCtx, websocket.MessageText, msg); err != nil {
					return
				}
			}
		}
	}
}

// terminalSizeQueue delivers PTY resize events to the remotecommand executor.
type terminalSizeQueue struct {
	ch   chan remotecommand.TerminalSize
	once sync.Once
}

func (q *terminalSizeQueue) Next() *remotecommand.TerminalSize {
	sz, ok := <-q.ch
	if !ok {
		return nil
	}
	return &sz
}

func (q *terminalSizeQueue) close() {
	q.once.Do(func() { close(q.ch) })
}

// send queues a resize; silently drops if the queue is full or already closed.
func (q *terminalSizeQueue) send(cols, rows uint16) {
	defer func() { recover() }() //nolint:errcheck — recover from send-on-closed-channel race
	select {
	case q.ch <- remotecommand.TerminalSize{Width: cols, Height: rows}:
	default: // drop if full
	}
}

// wsReadWriter bridges a WebSocket connection to io.Reader/io.Writer for remotecommand.
type wsReadWriter struct {
	conn      *websocket.Conn
	ctx       context.Context
	reader    io.Reader
	mu        sync.Mutex
	sizeQueue *terminalSizeQueue // non-nil for TTY sessions
}

func (w *wsReadWriter) Read(p []byte) (int, error) {
	for {
		if w.reader != nil {
			n, err := w.reader.Read(p)
			if n > 0 {
				return n, nil
			}
			if err != io.EOF {
				return 0, err
			}
			w.reader = nil
		}

		msgType, data, err := w.conn.Read(w.ctx)
		if err != nil {
			return 0, err
		}

		// Handle resize messages (JSON with cols/rows).
		if msgType == websocket.MessageText {
			var resize struct {
				Type string `json:"type"`
				Cols int    `json:"cols"`
				Rows int    `json:"rows"`
			}
			if json.Unmarshal(data, &resize) == nil && resize.Type == "resize" {
				if w.sizeQueue != nil {
					w.sizeQueue.send(uint16(resize.Cols), uint16(resize.Rows))
				}
				continue
			}
		}

		if len(data) > 0 {
			w.reader = bufio.NewReader(bytes.NewReader(data))
		}
	}
}

func (w *wsReadWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	err := w.conn.Write(w.ctx, websocket.MessageBinary, p)
	if err != nil {
		return 0, err
	}
	return len(p), nil
}

// --- HelmService ---

func (s *Server) ListReleases(
	_ context.Context,
	req *connect.Request[pb.ListReleasesRequest],
) (*connect.Response[pb.ListReleasesResponse], error) {
	ctxName := s.resolveContext(req.Msg.Context)
	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	releases, err := helmclient.ListReleases(cs.Config, req.Msg.Namespace)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("listing helm releases: %w", err))
	}

	var pbReleases []*pb.HelmRelease
	for _, r := range releases {
		pbReleases = append(pbReleases, helmReleaseToPb(r))
	}

	return connect.NewResponse(&pb.ListReleasesResponse{Releases: pbReleases}), nil
}

func (s *Server) GetRelease(
	_ context.Context,
	req *connect.Request[pb.GetReleaseRequest],
) (*connect.Response[pb.GetReleaseResponse], error) {
	ctxName := s.resolveContext(req.Msg.Context)
	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	rel, err := helmclient.GetRelease(cs.Config, req.Msg.Namespace, req.Msg.Name)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("getting helm release: %w", err))
	}

	return connect.NewResponse(&pb.GetReleaseResponse{Release: helmReleaseToPb(rel)}), nil
}

func (s *Server) GetReleaseValues(
	_ context.Context,
	req *connect.Request[pb.GetReleaseValuesRequest],
) (*connect.Response[pb.GetReleaseValuesResponse], error) {
	ctxName := s.resolveContext(req.Msg.Context)
	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	values, err := helmclient.GetValues(cs.Config, req.Msg.Namespace, req.Msg.Name)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("getting helm values: %w", err))
	}

	return connect.NewResponse(&pb.GetReleaseValuesResponse{ValuesYaml: values}), nil
}

func (s *Server) GetReleaseHistory(
	_ context.Context,
	req *connect.Request[pb.GetReleaseHistoryRequest],
) (*connect.Response[pb.GetReleaseHistoryResponse], error) {
	ctxName := s.resolveContext(req.Msg.Context)
	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	revisions, err := helmclient.GetHistory(cs.Config, req.Msg.Namespace, req.Msg.Name)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("getting helm history: %w", err))
	}

	var pbRevisions []*pb.ReleaseRevision
	for _, rev := range revisions {
		pbRevisions = append(pbRevisions, &pb.ReleaseRevision{
			Revision:    int32(rev.Revision),
			Status:      rev.Status,
			Chart:       rev.Chart,
			AppVersion:  rev.AppVersion,
			Updated:     rev.Updated,
			Description: rev.Description,
		})
	}

	return connect.NewResponse(&pb.GetReleaseHistoryResponse{Revisions: pbRevisions}), nil
}

func (s *Server) UninstallRelease(
	_ context.Context,
	req *connect.Request[pb.UninstallReleaseRequest],
) (*connect.Response[pb.UninstallReleaseResponse], error) {
	ctxName := s.resolveContext(req.Msg.Context)
	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	if err := helmclient.Uninstall(cs.Config, req.Msg.Namespace, req.Msg.Name); err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("uninstalling helm release: %w", err))
	}

	return connect.NewResponse(&pb.UninstallReleaseResponse{
		Success: true,
		Message: fmt.Sprintf("release %q uninstalled", req.Msg.Name),
	}), nil
}

func (s *Server) RollbackRelease(
	_ context.Context,
	req *connect.Request[pb.RollbackReleaseRequest],
) (*connect.Response[pb.RollbackReleaseResponse], error) {
	ctxName := s.resolveContext(req.Msg.Context)
	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	if err := helmclient.Rollback(cs.Config, req.Msg.Namespace, req.Msg.Name, int(req.Msg.Revision)); err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("rolling back helm release: %w", err))
	}

	return connect.NewResponse(&pb.RollbackReleaseResponse{
		Success: true,
		Message: fmt.Sprintf("release %q rolled back to revision %d", req.Msg.Name, req.Msg.Revision),
	}), nil
}

func (s *Server) UpgradeRelease(
	_ context.Context,
	req *connect.Request[pb.UpgradeReleaseRequest],
) (*connect.Response[pb.UpgradeReleaseResponse], error) {
	ctxName := s.resolveContext(req.Msg.Context)
	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	if err := helmclient.Upgrade(cs.Config, req.Msg.Namespace, req.Msg.Name, req.Msg.ValuesYaml); err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("upgrading helm release: %w", err))
	}

	return connect.NewResponse(&pb.UpgradeReleaseResponse{
		Success: true,
		Message: fmt.Sprintf("release %q upgraded", req.Msg.Name),
	}), nil
}

func (s *Server) CordonNode(
	ctx context.Context,
	req *connect.Request[pb.CordonNodeRequest],
) (*connect.Response[pb.CordonNodeResponse], error) {
	ctxName := s.resolveContext(req.Msg.Context)
	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	patch := []byte(`{"spec":{"unschedulable":true}}`)
	_, err = cs.Dynamic.Resource(nodeGVR).Patch(ctx, req.Msg.Name, types.MergePatchType, patch, metav1.PatchOptions{})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("cordoning node: %w", err))
	}

	return connect.NewResponse(&pb.CordonNodeResponse{
		Success: true,
		Message: fmt.Sprintf("node %q cordoned", req.Msg.Name),
	}), nil
}

func (s *Server) UncordonNode(
	ctx context.Context,
	req *connect.Request[pb.CordonNodeRequest],
) (*connect.Response[pb.CordonNodeResponse], error) {
	ctxName := s.resolveContext(req.Msg.Context)
	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	patch := []byte(`{"spec":{"unschedulable":false}}`)
	_, err = cs.Dynamic.Resource(nodeGVR).Patch(ctx, req.Msg.Name, types.MergePatchType, patch, metav1.PatchOptions{})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("uncordoning node: %w", err))
	}

	return connect.NewResponse(&pb.CordonNodeResponse{
		Success: true,
		Message: fmt.Sprintf("node %q uncordoned", req.Msg.Name),
	}), nil
}

func (s *Server) DrainNode(
	ctx context.Context,
	req *connect.Request[pb.DrainNodeRequest],
) (*connect.Response[pb.DrainNodeResponse], error) {
	ctxName := s.resolveContext(req.Msg.Context)
	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	// Cordon first.
	patch := []byte(`{"spec":{"unschedulable":true}}`)
	_, err = cs.Dynamic.Resource(nodeGVR).Patch(ctx, req.Msg.Name, types.MergePatchType, patch, metav1.PatchOptions{})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("cordoning node for drain: %w", err))
	}

	// List all pods on this node.
	pods, err := cs.Clientset.CoreV1().Pods("").List(ctx, metav1.ListOptions{
		FieldSelector: "spec.nodeName=" + req.Msg.Name,
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("listing pods on node: %w", err))
	}

	evictedCount := int32(0)
	for _, pod := range pods.Items {
		// Skip DaemonSet-owned pods.
		if req.Msg.IgnoreDaemonsets {
			isDaemonSet := false
			for _, ref := range pod.OwnerReferences {
				if ref.Kind == "DaemonSet" {
					isDaemonSet = true
					break
				}
			}
			if isDaemonSet {
				continue
			}
		}

		// Skip mirror pods.
		if _, isMirror := pod.Annotations["kubernetes.io/config.mirror"]; isMirror {
			continue
		}

		eviction := &policyv1.Eviction{
			ObjectMeta: metav1.ObjectMeta{
				Name:      pod.Name,
				Namespace: pod.Namespace,
			},
		}
		if err := cs.Clientset.PolicyV1().Evictions(pod.Namespace).Evict(ctx, eviction); err != nil {
			// Best-effort: continue on error.
			continue
		}
		evictedCount++
	}

	return connect.NewResponse(&pb.DrainNodeResponse{
		Success:      true,
		Message:      fmt.Sprintf("node %q drained, evicted %d pods", req.Msg.Name, evictedCount),
		EvictedCount: evictedCount,
	}), nil
}

func (s *Server) TriggerCronJob(
	ctx context.Context,
	req *connect.Request[pb.TriggerCronJobRequest],
) (*connect.Response[pb.TriggerCronJobResponse], error) {
	ctxName := s.resolveContext(req.Msg.Context)
	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("getting client: %w", err))
	}

	cronGVR := schema.GroupVersionResource{Group: "batch", Version: "v1", Resource: "cronjobs"}
	cj, err := cs.Dynamic.Resource(cronGVR).Namespace(req.Msg.Namespace).Get(ctx, req.Msg.Name, metav1.GetOptions{})
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("getting cronjob: %w", err))
	}

	jobSpec, found, err := unstructured.NestedMap(cj.Object, "spec", "jobTemplate", "spec")
	if err != nil || !found {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("jobTemplate.spec not found in CronJob"))
	}

	// Generate a unique job name; truncate to 63 chars (k8s DNS label limit).
	jobName := fmt.Sprintf("%s-manual-%d", req.Msg.Name, time.Now().Unix())
	if len(jobName) > 63 {
		jobName = jobName[:63]
	}

	job := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "batch/v1",
			"kind":       "Job",
			"metadata": map[string]interface{}{
				"name":      jobName,
				"namespace": req.Msg.Namespace,
				"annotations": map[string]interface{}{
					"cronjob.kubernetes.io/instantiate": "manual",
				},
				"ownerReferences": []interface{}{
					map[string]interface{}{
						"apiVersion":         "batch/v1",
						"kind":               "CronJob",
						"name":               req.Msg.Name,
						"uid":                string(cj.GetUID()),
						"controller":         true,
						"blockOwnerDeletion": true,
					},
				},
			},
			"spec": jobSpec,
		},
	}

	jobGVR := schema.GroupVersionResource{Group: "batch", Version: "v1", Resource: "jobs"}
	created, err := cs.Dynamic.Resource(jobGVR).Namespace(req.Msg.Namespace).Create(ctx, job, metav1.CreateOptions{})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("creating job: %w", err))
	}

	return connect.NewResponse(&pb.TriggerCronJobResponse{
		Success: true,
		JobName: created.GetName(),
		Message: fmt.Sprintf("job %q created from cronjob %q", created.GetName(), req.Msg.Name),
	}), nil
}

func helmReleaseToPb(r *helmclient.Release) *pb.HelmRelease {
	return &pb.HelmRelease{
		Name:         r.Name,
		Namespace:    r.Namespace,
		Chart:        r.Chart,
		ChartVersion: r.ChartVersion,
		AppVersion:   r.AppVersion,
		Status:       r.Status,
		Revision:     int32(r.Revision),
		Updated:      r.Updated,
		Notes:        r.Notes,
	}
}

func (s *Server) runExec(ctx context.Context, cs *kube.ClientSet, namespace, pod, container string, cmd []string, conn *websocket.Conn) error {
	execReq := cs.Clientset.CoreV1().RESTClient().Post().
		Resource("pods").
		Name(pod).
		Namespace(namespace).
		SubResource("exec")

	execOpts := &corev1.PodExecOptions{
		Command: cmd,
		Stdin:   true,
		Stdout:  true,
		Stderr:  true,
		TTY:     true,
	}
	if container != "" {
		execOpts.Container = container
	}

	execReq.VersionedParams(execOpts, scheme.ParameterCodec)

	executor, err := remotecommand.NewSPDYExecutor(cs.Config, "POST", execReq.URL())
	if err != nil {
		return fmt.Errorf("creating executor: %w", err)
	}

	sizeQueue := &terminalSizeQueue{ch: make(chan remotecommand.TerminalSize, 4)}
	defer sizeQueue.close()

	rw := &wsReadWriter{conn: conn, ctx: ctx, sizeQueue: sizeQueue}

	err = executor.StreamWithContext(ctx, remotecommand.StreamOptions{
		Stdin:             rw,
		Stdout:            rw,
		Stderr:            rw,
		Tty:               true,
		TerminalSizeQueue: sizeQueue,
	})
	return err
}

// --- Setup / context-management REST handlers ---

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

var pluginStorageIDRe = regexp.MustCompile(`^[a-zA-Z0-9._-]{1,120}$`)
var pluginStorageKeyRe = regexp.MustCompile(`^[a-zA-Z0-9._:/-]{1,200}$`)

func validatePluginStorageRef(pluginID, key string) error {
	if !pluginStorageIDRe.MatchString(pluginID) {
		return errors.New("invalid plugin_id")
	}
	if !pluginStorageKeyRe.MatchString(key) {
		return errors.New("invalid key")
	}
	return nil
}

func (s *Server) refreshAfterProfileChange() {
	s.watchCache.StopAll()
	s.kubeMgr.RefreshFromStore()
	s.searchMu.Lock()
	s.searchIndexes = make(map[string]*searchIndexState)
	s.searchMu.Unlock()
	if active := s.kubeMgr.ActiveContext(); active != "" {
		s.triggerSearchIndexRefresh(active)
	}
}

func (s *Server) handleSetupStatus(w http.ResponseWriter, _ *http.Request) {
	autoLockMinutes := 20
	if s.store.IsInitialized() && !s.store.IsLocked() {
		autoLockMinutes = s.store.AutoLockMinutes()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"initialized":       s.store.IsInitialized(),
		"locked":            s.store.IsLocked(),
		"broken":            s.store.IsBroken(),
		"broken_error":      s.store.BrokenError(),
		"method":            s.store.Method(),
		"auto_lock_minutes": autoLockMinutes,
	})
}

func (s *Server) handleSetupReset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := s.store.Reset(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	// Clear all cached kube clients and watch cache — they are all invalid after a reset.
	s.kubeMgr.ClearAllClients()
	s.watchCache.StopAll()
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleSetupInitialize(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Method   string `json:"method"`
		GpgKey   string `json:"gpg_key"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if err := s.store.Initialize(body.Method, body.GpgKey, body.Password); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleSetupUnlock(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if err := s.store.Unlock(body.Password); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
		return
	}
	s.refreshAfterProfileChange()
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleSetupLock(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := s.store.Lock(); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	// Clear all cached kube clients, watch cache, and search indexes after lock.
	s.kubeMgr.ClearAllClients()
	s.watchCache.StopAll()
	s.searchMu.Lock()
	s.searchIndexes = make(map[string]*searchIndexState)
	s.searchMu.Unlock()
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleSetupPreferences(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.store.IsInitialized() || s.store.IsLocked() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "store is not ready"})
		return
	}
	minutes := s.store.AutoLockMinutes()
	bypass := s.store.NeverConfirmStartupBypass()
	writeJSON(w, http.StatusOK, map[string]any{
		"auto_lock_minutes":             minutes,
		"startup_confirmation_required": minutes == 0 && !bypass,
		"never_confirm_startup_bypass":  bypass,
	})
}

func (s *Server) handleContextPreflight(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	contextName := strings.TrimSpace(r.URL.Query().Get("context"))
	if contextName == "" {
		contextName = strings.TrimSpace(s.kubeMgr.ActiveContext())
	}
	if contextName == "" {
		writeJSON(w, http.StatusOK, map[string]any{
			"context":             "",
			"has_exec_auth":       false,
			"missing_exec_helper": false,
		})
		return
	}

	entry, ok := s.store.GetContextEntry(contextName)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "context not found"})
		return
	}

	execCommand, execArgs, err := extractExecAuth(entry.Kubeconfig)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"context": contextName,
			"error":   err.Error(),
		})
		return
	}
	if execCommand == "" {
		writeJSON(w, http.StatusOK, map[string]any{
			"context":             contextName,
			"has_exec_auth":       false,
			"missing_exec_helper": false,
		})
		return
	}

	resolvedPath, missing := resolveExecPath(execCommand)
	recommendations := []string{}
	if missing {
		recommendations = append(
			recommendations,
			fmt.Sprintf("Install or restore '%s' for this context.", filepath.Base(execCommand)),
			"If already installed, add its directory in Preferences -> Connectivity -> Exec PATH Hints.",
			"Restart Truss to apply updated PATH hints to the backend daemon.",
		)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"context":             contextName,
		"has_exec_auth":       true,
		"exec_command":        execCommand,
		"exec_args":           execArgs,
		"resolved_path":       resolvedPath,
		"missing_exec_helper": missing,
		"message": func() string {
			if missing {
				return fmt.Sprintf("Missing auth helper '%s' in daemon PATH.", filepath.Base(execCommand))
			}
			return ""
		}(),
		"recommendations": recommendations,
	})
}

func extractExecAuth(kubeconfigYAML string) (string, []string, error) {
	cfg, err := clientcmd.Load([]byte(kubeconfigYAML))
	if err != nil {
		return "", nil, fmt.Errorf("parsing kubeconfig: %w", err)
	}
	if cfg.CurrentContext == "" {
		return "", nil, nil
	}
	ctx, ok := cfg.Contexts[cfg.CurrentContext]
	if !ok || ctx == nil || strings.TrimSpace(ctx.AuthInfo) == "" {
		return "", nil, nil
	}
	user, ok := cfg.AuthInfos[ctx.AuthInfo]
	if !ok || user == nil || user.Exec == nil {
		return "", nil, nil
	}
	command := strings.TrimSpace(user.Exec.Command)
	if command == "" {
		return "", nil, nil
	}
	return command, append([]string(nil), user.Exec.Args...), nil
}

func resolveExecPath(command string) (string, bool) {
	if filepath.IsAbs(command) {
		info, err := os.Stat(command)
		if err == nil && !info.IsDir() {
			return command, false
		}
		return "", true
	}
	resolved, err := exec.LookPath(command)
	if err != nil {
		return "", true
	}
	return resolved, false
}

func (s *Server) handleSetupAutoLockSet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		AutoLockMinutes int `json:"auto_lock_minutes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if err := s.store.SetAutoLockMinutes(body.AutoLockMinutes); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	bypass := s.store.NeverConfirmStartupBypass()
	writeJSON(w, http.StatusOK, map[string]any{
		"status":                        "ok",
		"auto_lock_minutes":             body.AutoLockMinutes,
		"startup_confirmation_required": body.AutoLockMinutes == 0 && !bypass,
		"never_confirm_startup_bypass":  bypass,
	})
}

func (s *Server) handleSetupNeverConfirmBypassSet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		NeverConfirmStartupBypass bool `json:"never_confirm_startup_bypass"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if err := s.store.SetNeverConfirmStartupBypass(body.NeverConfirmStartupBypass); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	minutes := s.store.AutoLockMinutes()
	writeJSON(w, http.StatusOK, map[string]any{
		"status":                        "ok",
		"auto_lock_minutes":             minutes,
		"startup_confirmation_required": minutes == 0 && !body.NeverConfirmStartupBypass,
		"never_confirm_startup_bypass":  body.NeverConfirmStartupBypass,
	})
}

func (s *Server) handleGPGKeys(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	keys, err := contextstore.ListGPGKeys()
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"keys": []any{}, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"keys": keys})
}

func (s *Server) handleKubeconfigContexts(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ctxs, err := contextstore.ListKubeconfigContexts()
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"contexts": []any{}, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"contexts": ctxs})
}

func (s *Server) handleProfilesList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	type profileInfo struct {
		Name  string `json:"name"`
		Color string `json:"color,omitempty"`
	}
	profileNames := s.store.ProfileNames()
	profiles := make([]profileInfo, 0, len(profileNames))
	for _, name := range profileNames {
		profiles = append(profiles, profileInfo{
			Name:  name,
			Color: s.store.ProfileColor(name),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"profiles":             profiles,
		"active_profile":       s.store.ActiveProfile(),
		"active_profile_color": s.store.ActiveProfileColor(),
	})
}

func (s *Server) handleProfilesCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if err := s.store.CreateProfile(body.Name); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleProfilesRename(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		OldName string `json:"old_name"`
		NewName string `json:"new_name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if err := s.store.RenameProfile(body.OldName, body.NewName); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	s.refreshAfterProfileChange()
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleProfilesDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if err := s.store.DeleteProfile(body.Name); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	s.refreshAfterProfileChange()
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleProfilesSetActive(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if err := s.store.SetActiveProfile(body.Name); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	s.refreshAfterProfileChange()
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleProfilesSetColor(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Name  string `json:"name"`
		Color string `json:"color"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if err := s.store.SetProfileColor(body.Name, body.Color); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handlePluginSecureStorageGet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		PluginID string `json:"plugin_id"`
		Key      string `json:"key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if err := validatePluginStorageRef(body.PluginID, body.Key); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	storeKey := body.PluginID + ":" + body.Key
	raw, ok := s.store.GetSecureValue(storeKey)
	if !ok || raw == "" {
		writeJSON(w, http.StatusOK, map[string]any{"value": nil})
		return
	}
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"value": nil})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"value": value})
}

func (s *Server) handlePluginSecureStorageSet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		PluginID string          `json:"plugin_id"`
		Key      string          `json:"key"`
		Value    json.RawMessage `json:"value"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if err := validatePluginStorageRef(body.PluginID, body.Key); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if len(body.Value) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "value is required"})
		return
	}
	if len(body.Value) > 64*1024 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "value too large"})
		return
	}
	if !json.Valid(body.Value) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "value must be valid JSON"})
		return
	}
	storeKey := body.PluginID + ":" + body.Key
	if err := s.store.SetSecureValue(storeKey, string(body.Value)); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handlePluginSecureStorageDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		PluginID string `json:"plugin_id"`
		Key      string `json:"key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if err := validatePluginStorageRef(body.PluginID, body.Key); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	storeKey := body.PluginID + ":" + body.Key
	if err := s.store.DeleteSecureValue(storeKey); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleContextsImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// Two modes: paste raw kubeconfig YAML, or pick a context by name from the system kubeconfig.
	var body struct {
		Name          string `json:"name"`
		DisplayName   string `json:"display_name"`
		Kubeconfig    string `json:"kubeconfig"`     // raw YAML (paste mode)
		SystemContext string `json:"system_context"` // context name from ~/.kube/config
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if body.Name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name is required"})
		return
	}

	var kubeconfigYAML string
	if body.SystemContext != "" {
		// Extract from system kubeconfig.
		extracted, err := contextstore.ExtractContextFromSystemKubeconfig(body.SystemContext)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		kubeconfigYAML = extracted
	} else if body.Kubeconfig != "" {
		// Use pasted kubeconfig directly (current-context must be set in the YAML).
		kubeconfigYAML = body.Kubeconfig
	} else {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "kubeconfig or system_context is required"})
		return
	}

	if err := s.store.ImportContext(body.Name, body.DisplayName, kubeconfigYAML); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	// Invalidate any cached client and watch cache so the new kubeconfig takes effect.
	s.kubeMgr.InvalidateClient(body.Name)
	s.watchCache.Invalidate(body.Name)
	// Ensure an active context is set.
	if s.kubeMgr.ActiveContext() == "" {
		_ = s.kubeMgr.SetActiveContext(body.Name)
	}
	s.triggerSearchIndexRefresh(body.Name)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleContextsDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if body.Name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name is required"})
		return
	}
	if err := s.store.RemoveContext(body.Name); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	s.kubeMgr.InvalidateClient(body.Name)
	s.watchCache.Invalidate(body.Name)
	if s.kubeMgr.ActiveContext() == body.Name {
		if next := s.store.LastActiveContext(); next != "" {
			_ = s.kubeMgr.SetActiveContext(next)
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
