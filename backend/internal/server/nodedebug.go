package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type nodeDebugRequest struct {
	Context   string `json:"context"`
	Node      string `json:"node"`
	Namespace string `json:"namespace"`
	Image     string `json:"image"`
}

type nodeDebugResponse struct {
	Pod       string `json:"pod"`
	Namespace string `json:"namespace"`
	Container string `json:"container"`
}

// handleNodeDebug creates a privileged debug pod on the target node, waits
// for it to become Running (up to 60 s), then returns the pod coordinates so
// the caller can open an exec session.
func (s *Server) handleNodeDebug(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req nodeDebugRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.Node == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "node is required"})
		return
	}
	if req.Namespace == "" {
		req.Namespace = "default"
	}
	if req.Image == "" {
		req.Image = "busybox"
	}

	ctxName := s.resolveContext(req.Context)
	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	privileged := true
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			GenerateName: "truss-node-debug-",
			Namespace:    req.Namespace,
			Labels: map[string]string{
				"app.kubernetes.io/managed-by": "truss",
				"truss.dev/node-debug":         req.Node,
			},
		},
		Spec: corev1.PodSpec{
			NodeName:      req.Node,
			HostPID:       true,
			HostNetwork:   true,
			HostIPC:       true,
			RestartPolicy: corev1.RestartPolicyNever,
			// Tolerate all taints so the pod lands on cordoned/tainted nodes too.
			Tolerations: []corev1.Toleration{
				{Operator: corev1.TolerationOpExists},
			},
			Containers: []corev1.Container{
				{
					Name:  "debug",
					Image: req.Image,
					// Keep the container alive so exec sessions can connect.
					Command: []string{"sh", "-c", "while :; do sleep 3600; done"},
					Stdin:   true,
					TTY:     true,
					SecurityContext: &corev1.SecurityContext{
						Privileged: &privileged,
					},
				},
			},
		},
	}

	created, err := cs.Clientset.CoreV1().Pods(req.Namespace).Create(r.Context(), pod, metav1.CreateOptions{})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("creating debug pod: %s", err)})
		return
	}
	podName := created.Name

	// Poll until Running (60 s timeout).
	pollCtx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	for {
		select {
		case <-pollCtx.Done():
			// Clean up and report timeout.
			_ = cs.Clientset.CoreV1().Pods(req.Namespace).Delete(context.Background(), podName, metav1.DeleteOptions{})
			writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "timed out waiting for debug pod to become ready"})
			return
		case <-time.After(500 * time.Millisecond):
		}

		p, err := cs.Clientset.CoreV1().Pods(req.Namespace).Get(pollCtx, podName, metav1.GetOptions{})
		if err != nil {
			continue
		}
		switch p.Status.Phase {
		case corev1.PodRunning:
			writeJSON(w, http.StatusOK, nodeDebugResponse{
				Pod:       podName,
				Namespace: req.Namespace,
				Container: "debug",
			})
			return
		case corev1.PodFailed, corev1.PodSucceeded:
			_ = cs.Clientset.CoreV1().Pods(req.Namespace).Delete(context.Background(), podName, metav1.DeleteOptions{})
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "debug pod failed to start"})
			return
		}
	}
}

// handleNodeDebugDelete removes a debug pod by name.
func (s *Server) handleNodeDebugDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	q := r.URL.Query()
	ctxName := s.resolveContext(q.Get("context"))
	podName := q.Get("pod")
	namespace := q.Get("namespace")
	if namespace == "" {
		namespace = "default"
	}
	if podName == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "pod is required"})
		return
	}

	cs, err := s.kubeMgr.GetClientSet(ctxName)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	// Verify the pod is actually a Truss-managed debug pod before deleting.
	existing, err := cs.Clientset.CoreV1().Pods(namespace).Get(r.Context(), podName, metav1.GetOptions{})
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "pod not found"})
		return
	}
	if existing.Labels["app.kubernetes.io/managed-by"] != "truss" || existing.Labels["truss.dev/node-debug"] == "" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "pod is not a Truss node-debug pod"})
		return
	}

	if err := cs.Clientset.CoreV1().Pods(namespace).Delete(r.Context(), podName, metav1.DeleteOptions{}); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"deleted": podName})
}
