package server

import (
	"context"
	"sort"
	"strings"

	"connectrpc.com/connect"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"

	pb "github.com/kroy/truss/backend/api/gen/go/truss/v1"
)

var (
	nodeGVR           = schema.GroupVersionResource{Version: "v1", Resource: "nodes"}
	podGVR            = schema.GroupVersionResource{Version: "v1", Resource: "pods"}
	eventCoreGVR      = schema.GroupVersionResource{Version: "v1", Resource: "events"}
	eventK8sIoGVR     = schema.GroupVersionResource{Group: "events.k8s.io", Version: "v1", Resource: "events"}
	deploymentGVR     = schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}
	statefulSetGVR    = schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "statefulsets"}
	daemonSetGVR      = schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "daemonsets"}
	nodeMetricsGVR    = schema.GroupVersionResource{Group: "metrics.k8s.io", Version: "v1beta1", Resource: "nodes"}
	podMetricsGVR     = schema.GroupVersionResource{Group: "metrics.k8s.io", Version: "v1beta1", Resource: "pods"}
)

func (s *Server) GetClusterOverview(
	ctx context.Context,
	req *connect.Request[pb.GetClusterOverviewRequest],
) (*connect.Response[pb.GetClusterOverviewResponse], error) {
	ctxName := s.resolveContext(req.Msg.Context)
	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	ns := req.Msg.Namespace
	resp := &pb.GetClusterOverviewResponse{}
	allWarm := true

	// events.k8s.io/v1 is the preferred API on modern clusters; discovery deduplicates
	// Event by category so only one GVR ends up registered in the watchcache.
	// Use whichever one is actually registered, falling back to core v1.
	evtGVR := eventCoreGVR
	if s.watchCache.HasGVR(ctxName, eventK8sIoGVR) {
		evtGVR = eventK8sIoGVR
	}

	// listFrom tries the watchcache first; on miss falls back to direct API and
	// warms the cache in the background. Returns items and whether cache was warm.
	listFrom := func(gvr schema.GroupVersionResource, listNS string) ([]unstructured.Unstructured, bool) {
		if items, synced := s.watchCache.ListAll(ctxName, gvr, listNS); synced {
			return items, true
		}
		go s.ensureWatchCache(ctxName, cs)
		var listErr error
		var list *unstructured.UnstructuredList
		if listNS == "" {
			list, listErr = cs.Dynamic.Resource(gvr).List(ctx, metav1.ListOptions{})
		} else {
			list, listErr = cs.Dynamic.Resource(gvr).Namespace(listNS).List(ctx, metav1.ListOptions{})
		}
		if listErr != nil {
			return nil, false
		}
		return list.Items, false
	}

	// Nodes are always cluster-scoped (ns=""). Keep items for allocatable map.
	nodeItems, nodeWarm := listFrom(nodeGVR, "")
	if !nodeWarm {
		allWarm = false
	}
	resp.Nodes = summarizeNodes(nodeItems)

	if podItems, warm := listFrom(podGVR, ns); !warm {
		allWarm = false
		resp.Pods = summarizePodPhases(podItems)
	} else {
		resp.Pods = summarizePodPhases(podItems)
	}

	if deployItems, warm := listFrom(deploymentGVR, ns); !warm {
		allWarm = false
		resp.Deployments = summarizeDeployments(deployItems)
	} else {
		resp.Deployments = summarizeDeployments(deployItems)
	}

	if stsItems, warm := listFrom(statefulSetGVR, ns); !warm {
		allWarm = false
		resp.StatefulSets = summarizeStatefulSets(stsItems)
	} else {
		resp.StatefulSets = summarizeStatefulSets(stsItems)
	}

	if dsItems, warm := listFrom(daemonSetGVR, ns); !warm {
		allWarm = false
		resp.DaemonSets = summarizeDaemonSets(dsItems)
	} else {
		resp.DaemonSets = summarizeDaemonSets(dsItems)
	}

	if evtItems, warm := listFrom(evtGVR, ns); !warm {
		allWarm = false
		resp.RecentWarnings = extractWarningEvents(evtItems, 10)
	} else {
		resp.RecentWarnings = extractWarningEvents(evtItems, 10)
	}

	resp.CacheWarm = allWarm

	// Metrics from metrics-server — direct List() only (metrics-server has no watch support).
	// Failure is silent: MetricsAvailable stays false and the UI shows a soft hint.
	nodeAlloc := buildNodeAllocMap(nodeItems)

	if nmList, nmErr := cs.Dynamic.Resource(nodeMetricsGVR).List(ctx, metav1.ListOptions{}); nmErr == nil {
		resp.MetricsAvailable = true
		resp.Nodes.Metrics = buildNodeMetrics(nmList.Items, nodeAlloc)
	}

	var pmList *unstructured.UnstructuredList
	if ns == "" {
		pmList, err = cs.Dynamic.Resource(podMetricsGVR).List(ctx, metav1.ListOptions{})
	} else {
		pmList, err = cs.Dynamic.Resource(podMetricsGVR).Namespace(ns).List(ctx, metav1.ListOptions{})
	}
	if err == nil {
		resp.MetricsAvailable = true
		resp.TopCpuPods, resp.TopMemPods = buildTopPods(pmList.Items, 10)
	}

	return connect.NewResponse(resp), nil
}

func summarizeNodes(items []unstructured.Unstructured) *pb.NodeSummary {
	s := &pb.NodeSummary{Total: int32(len(items))}
	for _, item := range items {
		conditions, _, _ := unstructured.NestedSlice(item.Object, "status", "conditions")
		ready := false
		for _, c := range conditions {
			cond, ok := c.(map[string]interface{})
			if !ok {
				continue
			}
			if t, _, _ := unstructured.NestedString(cond, "type"); t == "Ready" {
				if st, _, _ := unstructured.NestedString(cond, "status"); st == "True" {
					ready = true
				}
				break
			}
		}
		if ready {
			s.Ready++
		} else {
			s.NotReady++
		}
	}
	return s
}

func summarizePodPhases(items []unstructured.Unstructured) *pb.PodSummary {
	s := &pb.PodSummary{}
	for _, item := range items {
		phase, _, _ := unstructured.NestedString(item.Object, "status", "phase")
		switch phase {
		case "Running":
			s.Running++
		case "Pending":
			s.Pending++
		case "Failed":
			s.Failed++
		case "Succeeded":
			s.Succeeded++
		default:
			s.Unknown++
		}
	}
	return s
}

func summarizeDeployments(items []unstructured.Unstructured) *pb.WorkloadSummary {
	s := &pb.WorkloadSummary{Total: int32(len(items))}
	for _, item := range items {
		desired, _, _ := unstructured.NestedInt64(item.Object, "spec", "replicas")
		ready, _, _ := unstructured.NestedInt64(item.Object, "status", "readyReplicas")
		gen, _, _ := unstructured.NestedInt64(item.Object, "metadata", "generation")
		observed, _, _ := unstructured.NestedInt64(item.Object, "status", "observedGeneration")
		if gen > 0 && observed < gen {
			s.Updating++
		} else if ready >= desired {
			s.Ready++
		} else {
			s.NotReady++
		}
	}
	return s
}

func summarizeStatefulSets(items []unstructured.Unstructured) *pb.WorkloadSummary {
	s := &pb.WorkloadSummary{Total: int32(len(items))}
	for _, item := range items {
		desired, _, _ := unstructured.NestedInt64(item.Object, "spec", "replicas")
		ready, _, _ := unstructured.NestedInt64(item.Object, "status", "readyReplicas")
		gen, _, _ := unstructured.NestedInt64(item.Object, "metadata", "generation")
		observed, _, _ := unstructured.NestedInt64(item.Object, "status", "observedGeneration")
		if gen > 0 && observed < gen {
			s.Updating++
		} else if ready >= desired {
			s.Ready++
		} else {
			s.NotReady++
		}
	}
	return s
}

func summarizeDaemonSets(items []unstructured.Unstructured) *pb.WorkloadSummary {
	s := &pb.WorkloadSummary{Total: int32(len(items))}
	for _, item := range items {
		desired, _, _ := unstructured.NestedInt64(item.Object, "status", "desiredNumberScheduled")
		ready, _, _ := unstructured.NestedInt64(item.Object, "status", "numberReady")
		gen, _, _ := unstructured.NestedInt64(item.Object, "metadata", "generation")
		observed, _, _ := unstructured.NestedInt64(item.Object, "status", "observedGeneration")
		if gen > 0 && observed < gen {
			s.Updating++
		} else if ready >= desired {
			s.Ready++
		} else {
			s.NotReady++
		}
	}
	return s
}

func extractWarningEvents(items []unstructured.Unstructured, n int) []*pb.OverviewEvent {
	var warnings []unstructured.Unstructured
	for _, item := range items {
		t, _, _ := unstructured.NestedString(item.Object, "type")
		if t == "Warning" {
			warnings = append(warnings, item)
		}
	}
	// Sort descending by the best available event timestamp across both
	// core/v1 Event and events.k8s.io/v1 Event schemas.
	sort.SliceStable(warnings, func(i, j int) bool {
		ti := eventTimestamp(warnings[i])
		tj := eventTimestamp(warnings[j])
		return ti > tj
	})
	if len(warnings) > n {
		warnings = warnings[:n]
	}
	result := make([]*pb.OverviewEvent, 0, len(warnings))
	seen := make(map[string]struct{}, len(warnings))
	for _, item := range warnings {
		evtNS := item.GetNamespace()
		involvedKind := firstNestedString(item.Object,
			[]string{"involvedObject", "kind"},
			[]string{"regarding", "kind"},
		)
		involvedName := firstNestedString(item.Object,
			[]string{"involvedObject", "name"},
			[]string{"regarding", "name"},
		)
		reason := firstNestedString(item.Object, []string{"reason"})
		msg := firstNestedString(item.Object,
			[]string{"message"},
			[]string{"note"},
			[]string{"action"},
		)
		if !isUsefulOverviewWarning(involvedKind, reason, msg) {
			continue
		}
		if involvedKind == "" && involvedName == "" {
			involvedKind = "Event"
			involvedName = item.GetName()
		}
		lastTime := eventTimestamp(item)
		count := firstNestedInt64(item.Object,
			[]string{"count"},
			[]string{"deprecatedCount"},
			[]string{"series", "count"},
		)
		key := evtNS + "|" + involvedKind + "|" + involvedName + "|" + reason + "|" + msg
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, &pb.OverviewEvent{
			Namespace:    evtNS,
			InvolvedKind: involvedKind,
			InvolvedName: involvedName,
			Reason:       reason,
			Message:      msg,
			LastTime:     lastTime,
			Count:        int32(count),
		})
		if len(result) >= n {
			break
		}
	}
	return result
}

func isUsefulOverviewWarning(involvedKind, reason, msg string) bool {
	reasonLower := strings.ToLower(strings.TrimSpace(reason))
	msgLower := strings.ToLower(strings.TrimSpace(msg))

	// Skip rows that provide almost no actionable information.
	if reasonLower == "" && msgLower == "" {
		return false
	}

	// Suppress noisy cluster churn in the overview panel.
	if involvedKind == "Node" && (reasonLower == "ready" || reasonLower == "nodenotready" || reasonLower == "nodeready") {
		return false
	}

	// Frequent deprecation annotation warning spam is better handled elsewhere.
	if reasonLower == "deprecatedannotation" || strings.Contains(msgLower, "deprecatedannotation") {
		return false
	}

	return true
}

func eventTimestamp(item unstructured.Unstructured) string {
	return firstNestedString(item.Object,
		[]string{"eventTime"},
		[]string{"series", "lastObservedTime"},
		[]string{"deprecatedLastTimestamp"},
		[]string{"lastTimestamp"},
		[]string{"metadata", "creationTimestamp"},
	)
}

func firstNestedString(obj map[string]interface{}, paths ...[]string) string {
	for _, path := range paths {
		v, _, _ := unstructured.NestedString(obj, path...)
		if v != "" {
			return v
		}
	}
	return ""
}

func firstNestedInt64(obj map[string]interface{}, paths ...[]string) int64 {
	for _, path := range paths {
		v, found, _ := unstructured.NestedInt64(obj, path...)
		if found {
			return v
		}
	}
	return 0
}

// parseCPUMillicores parses a CPU quantity string (e.g. "250m", "1") into millicores.
func parseCPUMillicores(s string) int64 {
	q, err := resource.ParseQuantity(s)
	if err != nil {
		return 0
	}
	return q.MilliValue()
}

// parseMemoryBytes parses a memory quantity string (e.g. "512Mi", "1Gi") into bytes.
func parseMemoryBytes(s string) int64 {
	q, err := resource.ParseQuantity(s)
	if err != nil {
		return 0
	}
	if v, ok := q.AsInt64(); ok {
		return v
	}
	return q.Value()
}

// buildNodeAllocMap returns nodeName → [cpuMillicores, memBytes] from node objects.
func buildNodeAllocMap(nodes []unstructured.Unstructured) map[string][2]int64 {
	m := make(map[string][2]int64, len(nodes))
	for _, node := range nodes {
		name := node.GetName()
		cpuStr, _, _ := unstructured.NestedString(node.Object, "status", "allocatable", "cpu")
		memStr, _, _ := unstructured.NestedString(node.Object, "status", "allocatable", "memory")
		m[name] = [2]int64{parseCPUMillicores(cpuStr), parseMemoryBytes(memStr)}
	}
	return m
}

// buildNodeMetrics builds per-node metrics by combining NodeMetrics usage with node allocatable.
func buildNodeMetrics(items []unstructured.Unstructured, alloc map[string][2]int64) []*pb.NodeMetric {
	result := make([]*pb.NodeMetric, 0, len(items))
	for _, item := range items {
		name := item.GetName()
		cpuStr, _, _ := unstructured.NestedString(item.Object, "usage", "cpu")
		memStr, _, _ := unstructured.NestedString(item.Object, "usage", "memory")
		a := alloc[name]
		result = append(result, &pb.NodeMetric{
			Name:         name,
			CpuUsedM:     parseCPUMillicores(cpuStr),
			CpuAllocM:    a[0],
			MemUsedBytes: parseMemoryBytes(memStr),
			MemAllocBytes: a[1],
		})
	}
	// Sort by name for stable display order.
	sort.Slice(result, func(i, j int) bool {
		return result[i].Name < result[j].Name
	})
	return result
}

// buildTopPods returns top-N pods by CPU and memory usage respectively.
func buildTopPods(items []unstructured.Unstructured, n int) (topCPU, topMem []*pb.PodTopEntry) {
	entries := make([]*pb.PodTopEntry, 0, len(items))
	for _, item := range items {
		podNS := item.GetNamespace()
		podName := item.GetName()
		var totalCPU, totalMem int64
		containers, _, _ := unstructured.NestedSlice(item.Object, "containers")
		for _, c := range containers {
			cm, ok := c.(map[string]interface{})
			if !ok {
				continue
			}
			cpuStr, _, _ := unstructured.NestedString(cm, "usage", "cpu")
			memStr, _, _ := unstructured.NestedString(cm, "usage", "memory")
			totalCPU += parseCPUMillicores(cpuStr)
			totalMem += parseMemoryBytes(memStr)
		}
		entries = append(entries, &pb.PodTopEntry{
			Namespace: podNS,
			Name:      podName,
			CpuM:      totalCPU,
			MemBytes:  totalMem,
		})
	}

	// Top by CPU.
	cpuSorted := make([]*pb.PodTopEntry, len(entries))
	copy(cpuSorted, entries)
	sort.Slice(cpuSorted, func(i, j int) bool {
		return cpuSorted[i].CpuM > cpuSorted[j].CpuM
	})
	if len(cpuSorted) > n {
		cpuSorted = cpuSorted[:n]
	}

	// Top by memory.
	memSorted := make([]*pb.PodTopEntry, len(entries))
	copy(memSorted, entries)
	sort.Slice(memSorted, func(i, j int) bool {
		return memSorted[i].MemBytes > memSorted[j].MemBytes
	})
	if len(memSorted) > n {
		memSorted = memSorted[:n]
	}

	return cpuSorted, memSorted
}
