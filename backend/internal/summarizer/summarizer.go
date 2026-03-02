package summarizer

import (
	"fmt"
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// SummaryField is a key-value summary pair.
type SummaryField struct {
	Key   string
	Value string
}

// Condition represents a Kubernetes status condition.
type Condition struct {
	Type           string
	Status         string
	Reason         string
	Message        string
	LastTransition string
}

// Summarize produces summary fields for a resource based on its kind.
func Summarize(kind string, obj *unstructured.Unstructured) []SummaryField {
	switch kind {
	case "Pod":
		return summarizePod(obj)
	case "Deployment":
		return summarizeDeployment(obj)
	case "Service":
		return summarizeService(obj)
	case "Ingress":
		return summarizeIngress(obj)
	case "StatefulSet":
		return summarizeStatefulSet(obj)
	case "DaemonSet":
		return summarizeDaemonSet(obj)
	case "Job":
		return summarizeJob(obj)
	case "CronJob":
		return summarizeCronJob(obj)
	case "ConfigMap":
		return summarizeConfigMap(obj)
	case "Secret":
		return summarizeSecret(obj)
	case "Namespace":
		return summarizeNamespace(obj)
	case "Node":
		return summarizeNode(obj)
	default:
		return summarizeGeneric(obj)
	}
}

// ExtractConditions extracts .status.conditions from an unstructured object.
func ExtractConditions(obj *unstructured.Unstructured) []Condition {
	conditions, found, err := unstructured.NestedSlice(obj.Object, "status", "conditions")
	if err != nil || !found {
		return nil
	}
	var result []Condition
	for _, c := range conditions {
		cm, ok := c.(map[string]interface{})
		if !ok {
			continue
		}
		result = append(result, Condition{
			Type:           getString(cm, "type"),
			Status:         getString(cm, "status"),
			Reason:         getString(cm, "reason"),
			Message:        getString(cm, "message"),
			LastTransition: getString(cm, "lastTransitionTime"),
		})
	}
	return result
}

func summarizePod(obj *unstructured.Unstructured) []SummaryField {
	phase := getNestedString(obj, "status", "phase")
	var ready, total int
	containers, _, _ := unstructured.NestedSlice(obj.Object, "status", "containerStatuses")
	for _, c := range containers {
		cm, ok := c.(map[string]interface{})
		if !ok {
			continue
		}
		total++
		if r, ok := cm["ready"].(bool); ok && r {
			ready++
		}
	}
	var restarts int64
	for _, c := range containers {
		cm, ok := c.(map[string]interface{})
		if !ok {
			continue
		}
		if r, ok := cm["restartCount"].(int64); ok {
			restarts += r
		}
	}
	nodeName := getNestedString(obj, "spec", "nodeName")
	ip := getNestedString(obj, "status", "podIP")
	startedAt := podStartedAt(obj)

	return []SummaryField{
		{Key: "Status", Value: phase},
		{Key: "Ready", Value: fmt.Sprintf("%d/%d", ready, total)},
		{Key: "Restarts", Value: fmt.Sprintf("%d", restarts)},
		{Key: "StartedAt", Value: startedAt},
		{Key: "Node", Value: nodeName},
		{Key: "IP", Value: ip},
	}
}

func podStartedAt(obj *unstructured.Unstructured) string {
	parse := func(raw string) (time.Time, bool) {
		if raw == "" {
			return time.Time{}, false
		}
		ts, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			return time.Time{}, false
		}
		return ts, true
	}

	base := obj.GetCreationTimestamp().Time
	restarts := int64(0)
	var newestRunning time.Time

	collectStatuses := func(path ...string) {
		statuses, _, _ := unstructured.NestedSlice(obj.Object, path...)
		for _, s := range statuses {
			sm, ok := s.(map[string]interface{})
			if !ok {
				continue
			}
			switch v := sm["restartCount"].(type) {
			case int64:
				restarts += v
			case int32:
				restarts += int64(v)
			case float64:
				restarts += int64(v)
			}
			running, ok := sm["state"].(map[string]interface{})
			if !ok {
				continue
			}
			rm, ok := running["running"].(map[string]interface{})
			if !ok {
				continue
			}
			if ts, ok := parse(getString(rm, "startedAt")); ok && ts.After(newestRunning) {
				newestRunning = ts
			}
		}
	}

	collectStatuses("status", "containerStatuses")
	collectStatuses("status", "initContainerStatuses")

	if restarts > 0 && !newestRunning.IsZero() {
		return newestRunning.UTC().Format("2006-01-02T15:04:05Z")
	}
	if start, ok := parse(getNestedString(obj, "status", "startTime")); ok {
		return start.UTC().Format("2006-01-02T15:04:05Z")
	}
	if !base.IsZero() {
		return base.UTC().Format("2006-01-02T15:04:05Z")
	}
	return ""
}

func summarizeDeployment(obj *unstructured.Unstructured) []SummaryField {
	replicas := getNestedInt(obj, "status", "replicas")
	ready := getNestedInt(obj, "status", "readyReplicas")
	available := getNestedInt(obj, "status", "availableReplicas")
	desired := getNestedInt(obj, "spec", "replicas")

	return []SummaryField{
		{Key: "Ready", Value: fmt.Sprintf("%d/%d", ready, desired)},
		{Key: "Available", Value: fmt.Sprintf("%d", available)},
		{Key: "Replicas", Value: fmt.Sprintf("%d", replicas)},
	}
}

func summarizeIngress(obj *unstructured.Unstructured) []SummaryField {
	ingressClass := getNestedString(obj, "spec", "ingressClassName")
	rules, _, _ := unstructured.NestedSlice(obj.Object, "spec", "rules")

	var hosts []string
	seen := make(map[string]struct{})
	var backends []string

	for _, r := range rules {
		rm, ok := r.(map[string]interface{})
		if !ok {
			continue
		}
		if host := getString(rm, "host"); host != "" {
			hosts = append(hosts, host)
		}
		httpObj, ok := rm["http"].(map[string]interface{})
		if !ok {
			continue
		}
		paths, _ := httpObj["paths"].([]interface{})
		for _, p := range paths {
			pm, ok := p.(map[string]interface{})
			if !ok {
				continue
			}
			backendObj, ok := pm["backend"].(map[string]interface{})
			if !ok {
				continue
			}
			svcObj, ok := backendObj["service"].(map[string]interface{})
			if !ok {
				continue
			}
			svcName := getString(svcObj, "name")
			if svcName == "" {
				continue
			}
			portObj, _ := svcObj["port"].(map[string]interface{})
			var portStr string
			if portObj != nil {
				switch v := portObj["number"].(type) {
				case int64:
					portStr = fmt.Sprintf("%d", v)
				case float64:
					portStr = fmt.Sprintf("%d", int(v))
				}
			}
			if portStr == "" {
				continue
			}
			key := svcName + ":" + portStr
			if _, exists := seen[key]; !exists {
				seen[key] = struct{}{}
				backends = append(backends, key)
			}
		}
	}

	var fields []SummaryField
	if ingressClass != "" {
		fields = append(fields, SummaryField{Key: "Class", Value: ingressClass})
	}
	if len(hosts) > 0 {
		fields = append(fields, SummaryField{Key: "Hosts", Value: strings.Join(hosts, ", ")})
	}
	if len(backends) > 0 {
		fields = append(fields, SummaryField{Key: "Backends", Value: strings.Join(backends, ", ")})
	}
	return fields
}

func summarizeService(obj *unstructured.Unstructured) []SummaryField {
	svcType := getNestedString(obj, "spec", "type")
	clusterIP := getNestedString(obj, "spec", "clusterIP")

	ports, _, _ := unstructured.NestedSlice(obj.Object, "spec", "ports")
	var portStrs []string
	for _, p := range ports {
		pm, ok := p.(map[string]interface{})
		if !ok {
			continue
		}
		port := getString(pm, "port")
		proto := getString(pm, "protocol")
		portStrs = append(portStrs, fmt.Sprintf("%s/%s", port, proto))
	}

	return []SummaryField{
		{Key: "Type", Value: svcType},
		{Key: "ClusterIP", Value: clusterIP},
		{Key: "Ports", Value: strings.Join(portStrs, ", ")},
	}
}

func summarizeStatefulSet(obj *unstructured.Unstructured) []SummaryField {
	ready := getNestedInt(obj, "status", "readyReplicas")
	desired := getNestedInt(obj, "spec", "replicas")
	return []SummaryField{
		{Key: "Ready", Value: fmt.Sprintf("%d/%d", ready, desired)},
	}
}

func summarizeDaemonSet(obj *unstructured.Unstructured) []SummaryField {
	desired := getNestedInt(obj, "status", "desiredNumberScheduled")
	ready := getNestedInt(obj, "status", "numberReady")
	return []SummaryField{
		{Key: "Ready", Value: fmt.Sprintf("%d/%d", ready, desired)},
		{Key: "Desired", Value: fmt.Sprintf("%d", desired)},
	}
}

func summarizeJob(obj *unstructured.Unstructured) []SummaryField {
	succeeded := getNestedInt(obj, "status", "succeeded")
	failed := getNestedInt(obj, "status", "failed")
	return []SummaryField{
		{Key: "Succeeded", Value: fmt.Sprintf("%d", succeeded)},
		{Key: "Failed", Value: fmt.Sprintf("%d", failed)},
	}
}

func summarizeCronJob(obj *unstructured.Unstructured) []SummaryField {
	schedule, _, _ := unstructured.NestedString(obj.Object, "spec", "schedule")
	suspend, _, _ := unstructured.NestedBool(obj.Object, "spec", "suspend")
	active, _, _ := unstructured.NestedSlice(obj.Object, "status", "active")
	lastSchedule, _, _ := unstructured.NestedString(obj.Object, "status", "lastScheduleTime")
	lastSuccess, _, _ := unstructured.NestedString(obj.Object, "status", "lastSuccessfulTime")

	suspendStr := "false"
	if suspend {
		suspendStr = "true"
	}
	fields := []SummaryField{
		{Key: "Schedule", Value: schedule},
		{Key: "Suspend", Value: suspendStr},
		{Key: "Active", Value: fmt.Sprintf("%d", len(active))},
	}
	if lastSchedule != "" {
		fields = append(fields, SummaryField{Key: "LastSchedule", Value: lastSchedule})
	}
	if lastSuccess != "" {
		fields = append(fields, SummaryField{Key: "LastSuccess", Value: lastSuccess})
	}
	return fields
}

func summarizeConfigMap(obj *unstructured.Unstructured) []SummaryField {
	data, _, _ := unstructured.NestedMap(obj.Object, "data")
	return []SummaryField{
		{Key: "Keys", Value: fmt.Sprintf("%d", len(data))},
	}
}

func summarizeSecret(obj *unstructured.Unstructured) []SummaryField {
	secretType := getNestedString(obj, "type")
	data, _, _ := unstructured.NestedMap(obj.Object, "data")
	return []SummaryField{
		{Key: "Type", Value: secretType},
		{Key: "Keys", Value: fmt.Sprintf("%d", len(data))},
	}
}

func summarizeNamespace(obj *unstructured.Unstructured) []SummaryField {
	phase := getNestedString(obj, "status", "phase")
	return []SummaryField{
		{Key: "Status", Value: phase},
	}
}

func summarizeNode(obj *unstructured.Unstructured) []SummaryField {
	conditions := ExtractConditions(obj)
	status := "Unknown"
	for _, c := range conditions {
		if c.Type == "Ready" {
			if c.Status == "True" {
				status = "Ready"
			} else {
				status = "NotReady"
			}
		}
	}
	unschedulable, _, _ := unstructured.NestedBool(obj.Object, "spec", "unschedulable")
	unschedulableStr := "false"
	if unschedulable {
		unschedulableStr = "true"
	}
	return []SummaryField{
		{Key: "Status", Value: status},
		{Key: "Unschedulable", Value: unschedulableStr},
	}
}

func summarizeGeneric(obj *unstructured.Unstructured) []SummaryField {
	var fields []SummaryField
	phase := getNestedString(obj, "status", "phase")
	if phase != "" {
		fields = append(fields, SummaryField{Key: "Phase", Value: phase})
	}
	return fields
}

func getNestedString(obj *unstructured.Unstructured, fields ...string) string {
	val, found, err := unstructured.NestedString(obj.Object, fields...)
	if err != nil || !found {
		return ""
	}
	return val
}

func getNestedInt(obj *unstructured.Unstructured, fields ...string) int64 {
	val, found, err := unstructured.NestedInt64(obj.Object, fields...)
	if err != nil || !found {
		return 0
	}
	return val
}

func getString(m map[string]interface{}, key string) string {
	val, ok := m[key]
	if !ok {
		return ""
	}
	s, ok := val.(string)
	if !ok {
		return fmt.Sprintf("%v", val)
	}
	return s
}
