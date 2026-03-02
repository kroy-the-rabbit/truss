package summarizer

import (
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// u builds a minimal Unstructured from a plain map.
func u(obj map[string]interface{}) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: obj}
}

// fieldValue returns the Value of the first SummaryField with the given Key.
func fieldValue(fields []SummaryField, key string) (string, bool) {
	for _, f := range fields {
		if f.Key == key {
			return f.Value, true
		}
	}
	return "", false
}

func mustField(t *testing.T, fields []SummaryField, key string) string {
	t.Helper()
	v, ok := fieldValue(fields, key)
	if !ok {
		t.Fatalf("expected field %q, got fields: %+v", key, fields)
	}
	return v
}

// ---------------------------------------------------------------------------
// Pod
// ---------------------------------------------------------------------------

func TestSummarizePodBasic(t *testing.T) {
	obj := u(map[string]interface{}{
		"status": map[string]interface{}{
			"phase": "Running",
			"podIP": "10.0.0.5",
			"containerStatuses": []interface{}{
				map[string]interface{}{"ready": true, "restartCount": int64(0)},
				map[string]interface{}{"ready": true, "restartCount": int64(2)},
			},
		},
		"spec": map[string]interface{}{
			"nodeName": "node-1",
		},
	})
	fields := Summarize("Pod", obj)
	if got := mustField(t, fields, "Status"); got != "Running" {
		t.Errorf("Status = %q, want Running", got)
	}
	if got := mustField(t, fields, "Ready"); got != "2/2" {
		t.Errorf("Ready = %q, want 2/2", got)
	}
	if got := mustField(t, fields, "Restarts"); got != "2" {
		t.Errorf("Restarts = %q, want 2", got)
	}
	if got := mustField(t, fields, "Node"); got != "node-1" {
		t.Errorf("Node = %q, want node-1", got)
	}
	if got := mustField(t, fields, "IP"); got != "10.0.0.5" {
		t.Errorf("IP = %q, want 10.0.0.5", got)
	}
}

func TestSummarizePodPartialReady(t *testing.T) {
	obj := u(map[string]interface{}{
		"status": map[string]interface{}{
			"phase": "Pending",
			"containerStatuses": []interface{}{
				map[string]interface{}{"ready": false, "restartCount": int64(0)},
				map[string]interface{}{"ready": true, "restartCount": int64(1)},
			},
		},
	})
	fields := Summarize("Pod", obj)
	if got := mustField(t, fields, "Ready"); got != "1/2" {
		t.Errorf("Ready = %q, want 1/2", got)
	}
}

func TestSummarizePodEmpty(t *testing.T) {
	// No status fields — should not panic.
	fields := Summarize("Pod", u(map[string]interface{}{}))
	if got := mustField(t, fields, "Status"); got != "" {
		t.Errorf("expected empty Status, got %q", got)
	}
	if got := mustField(t, fields, "Ready"); got != "0/0" {
		t.Errorf("expected 0/0 Ready, got %q", got)
	}
}

func TestPodStartedAtUsesStartTime(t *testing.T) {
	obj := u(map[string]interface{}{
		"status": map[string]interface{}{
			"startTime": "2026-01-15T10:00:00Z",
		},
	})
	fields := Summarize("Pod", obj)
	if got := mustField(t, fields, "StartedAt"); got != "2026-01-15T10:00:00Z" {
		t.Errorf("StartedAt = %q, want 2026-01-15T10:00:00Z", got)
	}
}

func TestPodStartedAtFallsBackToCreationTimestamp(t *testing.T) {
	obj := &unstructured.Unstructured{Object: map[string]interface{}{}}
	obj.SetCreationTimestamp(metav1.Date(2026, 1, 20, 8, 30, 0, 0, metav1.Now().Location()))
	fields := Summarize("Pod", obj)
	got := mustField(t, fields, "StartedAt")
	if got == "" {
		t.Error("StartedAt should fall back to creation timestamp")
	}
}

func TestPodStartedAtUsesNewestRunningOnRestart(t *testing.T) {
	obj := u(map[string]interface{}{
		"status": map[string]interface{}{
			"containerStatuses": []interface{}{
				map[string]interface{}{
					"restartCount": int64(1),
					"state": map[string]interface{}{
						"running": map[string]interface{}{
							"startedAt": "2026-02-10T12:00:00Z",
						},
					},
				},
			},
		},
	})
	fields := Summarize("Pod", obj)
	if got := mustField(t, fields, "StartedAt"); got != "2026-02-10T12:00:00Z" {
		t.Errorf("StartedAt = %q, want newest running time on restart", got)
	}
}

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

func TestSummarizeDeployment(t *testing.T) {
	obj := u(map[string]interface{}{
		"spec":   map[string]interface{}{"replicas": int64(3)},
		"status": map[string]interface{}{"replicas": int64(3), "readyReplicas": int64(2), "availableReplicas": int64(2)},
	})
	fields := Summarize("Deployment", obj)
	if got := mustField(t, fields, "Ready"); got != "2/3" {
		t.Errorf("Ready = %q, want 2/3", got)
	}
	if got := mustField(t, fields, "Available"); got != "2" {
		t.Errorf("Available = %q, want 2", got)
	}
}

func TestSummarizeDeploymentZeroReplicas(t *testing.T) {
	obj := u(map[string]interface{}{})
	fields := Summarize("Deployment", obj)
	if got := mustField(t, fields, "Ready"); got != "0/0" {
		t.Errorf("Ready = %q, want 0/0 for empty deployment", got)
	}
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

func TestSummarizeService(t *testing.T) {
	obj := u(map[string]interface{}{
		"spec": map[string]interface{}{
			"type":      "ClusterIP",
			"clusterIP": "10.96.0.1",
			"ports": []interface{}{
				map[string]interface{}{"port": "80", "protocol": "TCP"},
				map[string]interface{}{"port": "443", "protocol": "TCP"},
			},
		},
	})
	fields := Summarize("Service", obj)
	if got := mustField(t, fields, "Type"); got != "ClusterIP" {
		t.Errorf("Type = %q, want ClusterIP", got)
	}
	if got := mustField(t, fields, "ClusterIP"); got != "10.96.0.1" {
		t.Errorf("ClusterIP = %q, want 10.96.0.1", got)
	}
	if got := mustField(t, fields, "Ports"); got != "80/TCP, 443/TCP" {
		t.Errorf("Ports = %q, want 80/TCP, 443/TCP", got)
	}
}

func TestSummarizeServiceNoPorts(t *testing.T) {
	obj := u(map[string]interface{}{
		"spec": map[string]interface{}{"type": "ExternalName"},
	})
	fields := Summarize("Service", obj)
	if got := mustField(t, fields, "Ports"); got != "" {
		t.Errorf("expected empty Ports for no-port service, got %q", got)
	}
}

// ---------------------------------------------------------------------------
// StatefulSet / DaemonSet / Job
// ---------------------------------------------------------------------------

func TestSummarizeStatefulSet(t *testing.T) {
	obj := u(map[string]interface{}{
		"spec":   map[string]interface{}{"replicas": int64(5)},
		"status": map[string]interface{}{"readyReplicas": int64(4)},
	})
	fields := Summarize("StatefulSet", obj)
	if got := mustField(t, fields, "Ready"); got != "4/5" {
		t.Errorf("Ready = %q, want 4/5", got)
	}
}

func TestSummarizeDaemonSet(t *testing.T) {
	obj := u(map[string]interface{}{
		"status": map[string]interface{}{
			"desiredNumberScheduled": int64(3),
			"numberReady":            int64(3),
		},
	})
	fields := Summarize("DaemonSet", obj)
	if got := mustField(t, fields, "Ready"); got != "3/3" {
		t.Errorf("Ready = %q, want 3/3", got)
	}
	if got := mustField(t, fields, "Desired"); got != "3" {
		t.Errorf("Desired = %q, want 3", got)
	}
}

func TestSummarizeJob(t *testing.T) {
	obj := u(map[string]interface{}{
		"status": map[string]interface{}{
			"succeeded": int64(5),
			"failed":    int64(1),
		},
	})
	fields := Summarize("Job", obj)
	if got := mustField(t, fields, "Succeeded"); got != "5" {
		t.Errorf("Succeeded = %q, want 5", got)
	}
	if got := mustField(t, fields, "Failed"); got != "1" {
		t.Errorf("Failed = %q, want 1", got)
	}
}

// ---------------------------------------------------------------------------
// CronJob
// ---------------------------------------------------------------------------

func TestSummarizeCronJobFull(t *testing.T) {
	obj := u(map[string]interface{}{
		"spec": map[string]interface{}{
			"schedule": "0 * * * *",
			"suspend":  false,
		},
		"status": map[string]interface{}{
			"active":              []interface{}{map[string]interface{}{}, map[string]interface{}{}},
			"lastScheduleTime":    "2026-02-24T12:00:00Z",
			"lastSuccessfulTime":  "2026-02-24T11:00:00Z",
		},
	})
	fields := Summarize("CronJob", obj)
	if got := mustField(t, fields, "Schedule"); got != "0 * * * *" {
		t.Errorf("Schedule = %q, want 0 * * * *", got)
	}
	if got := mustField(t, fields, "Suspend"); got != "false" {
		t.Errorf("Suspend = %q, want false", got)
	}
	if got := mustField(t, fields, "Active"); got != "2" {
		t.Errorf("Active = %q, want 2", got)
	}
	if got := mustField(t, fields, "LastSchedule"); got != "2026-02-24T12:00:00Z" {
		t.Errorf("LastSchedule = %q", got)
	}
}

func TestSummarizeCronJobSuspended(t *testing.T) {
	obj := u(map[string]interface{}{
		"spec": map[string]interface{}{"schedule": "@daily", "suspend": true},
	})
	fields := Summarize("CronJob", obj)
	if got := mustField(t, fields, "Suspend"); got != "true" {
		t.Errorf("Suspend = %q, want true", got)
	}
	// No lastSchedule field when absent.
	if _, ok := fieldValue(fields, "LastSchedule"); ok {
		t.Error("expected no LastSchedule field when lastScheduleTime is empty")
	}
}

// ---------------------------------------------------------------------------
// ConfigMap / Secret
// ---------------------------------------------------------------------------

func TestSummarizeConfigMap(t *testing.T) {
	obj := u(map[string]interface{}{
		"data": map[string]interface{}{
			"key1": "val1",
			"key2": "val2",
			"key3": "val3",
		},
	})
	fields := Summarize("ConfigMap", obj)
	if got := mustField(t, fields, "Keys"); got != "3" {
		t.Errorf("Keys = %q, want 3", got)
	}
}

func TestSummarizeConfigMapEmpty(t *testing.T) {
	fields := Summarize("ConfigMap", u(map[string]interface{}{}))
	if got := mustField(t, fields, "Keys"); got != "0" {
		t.Errorf("Keys = %q, want 0", got)
	}
}

func TestSummarizeSecret(t *testing.T) {
	obj := u(map[string]interface{}{
		"type": "kubernetes.io/tls",
		"data": map[string]interface{}{
			"tls.crt": "base64==",
			"tls.key": "base64==",
		},
	})
	fields := Summarize("Secret", obj)
	if got := mustField(t, fields, "Type"); got != "kubernetes.io/tls" {
		t.Errorf("Type = %q, want kubernetes.io/tls", got)
	}
	if got := mustField(t, fields, "Keys"); got != "2" {
		t.Errorf("Keys = %q, want 2", got)
	}
}

// ---------------------------------------------------------------------------
// Namespace
// ---------------------------------------------------------------------------

func TestSummarizeNamespace(t *testing.T) {
	obj := u(map[string]interface{}{
		"status": map[string]interface{}{"phase": "Active"},
	})
	fields := Summarize("Namespace", obj)
	if got := mustField(t, fields, "Status"); got != "Active" {
		t.Errorf("Status = %q, want Active", got)
	}
}

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

func TestSummarizeNodeReady(t *testing.T) {
	obj := u(map[string]interface{}{
		"status": map[string]interface{}{
			"conditions": []interface{}{
				map[string]interface{}{"type": "Ready", "status": "True"},
			},
		},
		"spec": map[string]interface{}{"unschedulable": false},
	})
	fields := Summarize("Node", obj)
	if got := mustField(t, fields, "Status"); got != "Ready" {
		t.Errorf("Status = %q, want Ready", got)
	}
	if got := mustField(t, fields, "Unschedulable"); got != "false" {
		t.Errorf("Unschedulable = %q, want false", got)
	}
}

func TestSummarizeNodeNotReady(t *testing.T) {
	obj := u(map[string]interface{}{
		"status": map[string]interface{}{
			"conditions": []interface{}{
				map[string]interface{}{"type": "Ready", "status": "False"},
			},
		},
		"spec": map[string]interface{}{"unschedulable": true},
	})
	fields := Summarize("Node", obj)
	if got := mustField(t, fields, "Status"); got != "NotReady" {
		t.Errorf("Status = %q, want NotReady", got)
	}
	if got := mustField(t, fields, "Unschedulable"); got != "true" {
		t.Errorf("Unschedulable = %q, want true", got)
	}
}

func TestSummarizeNodeNoConditions(t *testing.T) {
	obj := u(map[string]interface{}{})
	fields := Summarize("Node", obj)
	if got := mustField(t, fields, "Status"); got != "Unknown" {
		t.Errorf("Status = %q, want Unknown for node with no conditions", got)
	}
}

// ---------------------------------------------------------------------------
// Generic / Unknown kind
// ---------------------------------------------------------------------------

func TestSummarizeGenericWithPhase(t *testing.T) {
	obj := u(map[string]interface{}{
		"status": map[string]interface{}{"phase": "Bound"},
	})
	fields := Summarize("PersistentVolumeClaim", obj)
	if got := mustField(t, fields, "Phase"); got != "Bound" {
		t.Errorf("Phase = %q, want Bound", got)
	}
}

func TestSummarizeGenericNoPhase(t *testing.T) {
	// Unknown kind with no phase → empty summary is valid (no panic).
	fields := Summarize("MyCustomResource", u(map[string]interface{}{}))
	if len(fields) != 0 {
		t.Errorf("expected 0 fields for unknown kind with no phase, got %d: %+v", len(fields), fields)
	}
}

// ---------------------------------------------------------------------------
// ExtractConditions
// ---------------------------------------------------------------------------

func TestExtractConditions(t *testing.T) {
	obj := u(map[string]interface{}{
		"status": map[string]interface{}{
			"conditions": []interface{}{
				map[string]interface{}{
					"type":               "Ready",
					"status":             "True",
					"reason":             "KubeletReady",
					"message":            "kubelet is posting ready status",
					"lastTransitionTime": "2026-01-01T00:00:00Z",
				},
				map[string]interface{}{
					"type":   "MemoryPressure",
					"status": "False",
				},
			},
		},
	})
	conds := ExtractConditions(obj)
	if len(conds) != 2 {
		t.Fatalf("expected 2 conditions, got %d", len(conds))
	}
	if conds[0].Type != "Ready" || conds[0].Status != "True" {
		t.Errorf("condition[0]: type=%q status=%q", conds[0].Type, conds[0].Status)
	}
	if conds[0].Reason != "KubeletReady" {
		t.Errorf("condition[0].Reason = %q, want KubeletReady", conds[0].Reason)
	}
	if conds[1].Type != "MemoryPressure" {
		t.Errorf("condition[1].Type = %q, want MemoryPressure", conds[1].Type)
	}
}

func TestExtractConditionsEmpty(t *testing.T) {
	conds := ExtractConditions(u(map[string]interface{}{}))
	if conds != nil {
		t.Errorf("expected nil conditions for object with no status, got %+v", conds)
	}
}

// ---------------------------------------------------------------------------
// getString helper
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Ingress
// ---------------------------------------------------------------------------

func TestSummarizeIngressFull(t *testing.T) {
	obj := u(map[string]interface{}{
		"spec": map[string]interface{}{
			"ingressClassName": "nginx",
			"rules": []interface{}{
				map[string]interface{}{
					"host": "foo.example.com",
					"http": map[string]interface{}{
						"paths": []interface{}{
							map[string]interface{}{
								"backend": map[string]interface{}{
									"service": map[string]interface{}{
										"name": "my-svc",
										"port": map[string]interface{}{"number": int64(80)},
									},
								},
							},
						},
					},
				},
				map[string]interface{}{
					"host": "bar.example.com",
					"http": map[string]interface{}{
						"paths": []interface{}{
							map[string]interface{}{
								"backend": map[string]interface{}{
									"service": map[string]interface{}{
										"name": "other-svc",
										"port": map[string]interface{}{"number": int64(443)},
									},
								},
							},
						},
					},
				},
			},
		},
	})
	fields := Summarize("Ingress", obj)
	if got := mustField(t, fields, "Class"); got != "nginx" {
		t.Errorf("Class = %q, want nginx", got)
	}
	if got := mustField(t, fields, "Hosts"); got != "foo.example.com, bar.example.com" {
		t.Errorf("Hosts = %q", got)
	}
	if got := mustField(t, fields, "Backends"); got != "my-svc:80, other-svc:443" {
		t.Errorf("Backends = %q", got)
	}
}

func TestSummarizeIngressDeduplicatesBackends(t *testing.T) {
	// Two paths to the same backend should produce one entry.
	obj := u(map[string]interface{}{
		"spec": map[string]interface{}{
			"rules": []interface{}{
				map[string]interface{}{
					"host": "foo.example.com",
					"http": map[string]interface{}{
						"paths": []interface{}{
							map[string]interface{}{
								"backend": map[string]interface{}{
									"service": map[string]interface{}{
										"name": "svc",
										"port": map[string]interface{}{"number": int64(80)},
									},
								},
							},
							map[string]interface{}{
								"backend": map[string]interface{}{
									"service": map[string]interface{}{
										"name": "svc",
										"port": map[string]interface{}{"number": int64(80)},
									},
								},
							},
						},
					},
				},
			},
		},
	})
	fields := Summarize("Ingress", obj)
	if got := mustField(t, fields, "Backends"); got != "svc:80" {
		t.Errorf("Backends = %q, want svc:80 (deduped)", got)
	}
}

func TestSummarizeIngressEmpty(t *testing.T) {
	obj := u(map[string]interface{}{})
	fields := Summarize("Ingress", obj)
	if len(fields) != 0 {
		t.Errorf("expected no fields for empty Ingress, got %+v", fields)
	}
}

func TestSummarizeIngressNoClass(t *testing.T) {
	obj := u(map[string]interface{}{
		"spec": map[string]interface{}{
			"rules": []interface{}{
				map[string]interface{}{
					"host": "foo.example.com",
					"http": map[string]interface{}{
						"paths": []interface{}{
							map[string]interface{}{
								"backend": map[string]interface{}{
									"service": map[string]interface{}{
										"name": "svc",
										"port": map[string]interface{}{"number": float64(8080)},
									},
								},
							},
						},
					},
				},
			},
		},
	})
	fields := Summarize("Ingress", obj)
	if _, ok := fieldValue(fields, "Class"); ok {
		t.Error("expected no Class field when ingressClassName is absent")
	}
	if got := mustField(t, fields, "Backends"); got != "svc:8080" {
		t.Errorf("Backends = %q, want svc:8080", got)
	}
}

func TestGetString(t *testing.T) {
	m := map[string]interface{}{
		"str":   "hello",
		"num":   int64(42),
		"bool":  true,
	}
	if got := getString(m, "str"); got != "hello" {
		t.Errorf("getString(str) = %q, want hello", got)
	}
	if got := getString(m, "num"); got != "42" {
		t.Errorf("getString(num) = %q, want 42", got)
	}
	if got := getString(m, "missing"); got != "" {
		t.Errorf("getString(missing) = %q, want empty", got)
	}
}
