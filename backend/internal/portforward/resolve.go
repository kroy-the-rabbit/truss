package portforward

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/kubernetes"
)

// Kinds of port-forward targets.
const (
	KindPod     = "pod"
	KindService = "service"
)

// PortRef is a port given either as a number or as a port name. In JSON it
// accepts both 8080 and "8080"/"http", and marshals numeric ports as numbers.
type PortRef string

// UnmarshalJSON accepts a JSON number or string.
func (p *PortRef) UnmarshalJSON(b []byte) error {
	var n json.Number
	if err := json.Unmarshal(b, &n); err == nil {
		*p = PortRef(n.String())
		return nil
	}
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return fmt.Errorf("port must be a number or a port name")
	}
	*p = PortRef(strings.TrimSpace(s))
	return nil
}

// MarshalJSON emits numeric ports as numbers and names as strings.
func (p PortRef) MarshalJSON() ([]byte, error) {
	if n, ok := p.Number(); ok {
		return []byte(strconv.Itoa(n)), nil
	}
	return json.Marshal(string(p))
}

// Number returns the port as an int when it is a valid numeric port.
func (p PortRef) Number() (int, bool) {
	n, err := strconv.Atoi(string(p))
	if err != nil || n <= 0 || n > 65535 {
		return 0, false
	}
	return n, true
}

// Target identifies what to forward to.
type Target struct {
	Context    string  `json:"context"`
	Namespace  string  `json:"namespace"`
	Kind       string  `json:"kind"`
	Name       string  `json:"name"`
	RemotePort PortRef `json:"remote_port"`
}

func (t Target) validate() error {
	if t.Namespace == "" || t.Name == "" {
		return fmt.Errorf("namespace and name are required")
	}
	if t.Kind != KindPod && t.Kind != KindService {
		return fmt.Errorf("kind must be %q or %q", KindPod, KindService)
	}
	if t.RemotePort == "" {
		return fmt.Errorf("remote_port is required")
	}
	if _, ok := t.RemotePort.Number(); !ok && !isPortName(string(t.RemotePort)) {
		return fmt.Errorf("invalid remote_port %q", t.RemotePort)
	}
	return nil
}

func isPortName(s string) bool {
	if s == "" || len(s) > 15 {
		return false
	}
	hasLetter := false
	for i, r := range s {
		switch {
		case r >= 'a' && r <= 'z':
			hasLetter = true
		case r >= '0' && r <= '9':
		case r == '-' && i > 0 && i < len(s)-1:
		default:
			return false
		}
	}
	// IANA service names must contain at least one letter.
	return hasLetter
}

// Resolved is the concrete pod and container port a target maps to.
type Resolved struct {
	Pod  string
	Port int
}

// Resolve maps a target to a running pod and numeric container port, the way
// `kubectl port-forward` does.
func Resolve(ctx context.Context, client kubernetes.Interface, t Target) (Resolved, error) {
	if err := t.validate(); err != nil {
		return Resolved{}, err
	}
	switch t.Kind {
	case KindPod:
		pod, err := client.CoreV1().Pods(t.Namespace).Get(ctx, t.Name, metav1.GetOptions{})
		if err != nil {
			return Resolved{}, fmt.Errorf("getting pod %s/%s: %w", t.Namespace, t.Name, err)
		}
		if pod.Status.Phase != corev1.PodRunning {
			return Resolved{}, fmt.Errorf("pod %s/%s is not running (phase %s)", t.Namespace, t.Name, pod.Status.Phase)
		}
		port, err := podPort(pod, t.RemotePort)
		if err != nil {
			return Resolved{}, err
		}
		return Resolved{Pod: pod.Name, Port: port}, nil
	default:
		return resolveService(ctx, client, t)
	}
}

func resolveService(ctx context.Context, client kubernetes.Interface, t Target) (Resolved, error) {
	svc, err := client.CoreV1().Services(t.Namespace).Get(ctx, t.Name, metav1.GetOptions{})
	if err != nil {
		return Resolved{}, fmt.Errorf("getting service %s/%s: %w", t.Namespace, t.Name, err)
	}
	if len(svc.Spec.Selector) == 0 {
		return Resolved{}, fmt.Errorf("service %s/%s has no pod selector", t.Namespace, t.Name)
	}
	svcPort, err := findServicePort(svc, t.RemotePort)
	if err != nil {
		return Resolved{}, err
	}

	pods, err := client.CoreV1().Pods(t.Namespace).List(ctx, metav1.ListOptions{
		LabelSelector: labels.SelectorFromSet(svc.Spec.Selector).String(),
	})
	if err != nil {
		return Resolved{}, fmt.Errorf("listing pods for service %s/%s: %w", t.Namespace, t.Name, err)
	}
	pod := pickReadyPod(pods.Items)
	if pod == nil {
		return Resolved{}, fmt.Errorf("service %s/%s has no ready pods", t.Namespace, t.Name)
	}

	target := svcPort.TargetPort
	var port int
	switch {
	case target.Type == intstr.String && target.StrVal != "":
		port, err = podPort(pod, PortRef(target.StrVal))
		if err != nil {
			return Resolved{}, fmt.Errorf("service %s/%s targetPort %q: %w", t.Namespace, t.Name, target.StrVal, err)
		}
	case target.Type == intstr.Int && target.IntVal > 0:
		port = int(target.IntVal)
	default:
		// An unset targetPort defaults to the service port.
		port = int(svcPort.Port)
	}
	return Resolved{Pod: pod.Name, Port: port}, nil
}

func findServicePort(svc *corev1.Service, ref PortRef) (corev1.ServicePort, error) {
	if n, ok := ref.Number(); ok {
		for _, p := range svc.Spec.Ports {
			if int(p.Port) == n {
				return p, nil
			}
		}
		return corev1.ServicePort{}, fmt.Errorf("service %s/%s does not expose port %d", svc.Namespace, svc.Name, n)
	}
	for _, p := range svc.Spec.Ports {
		if p.Name == string(ref) {
			return p, nil
		}
	}
	return corev1.ServicePort{}, fmt.Errorf("service %s/%s has no port named %q", svc.Namespace, svc.Name, string(ref))
}

// podPort resolves a numeric or named port against the pod's container ports.
func podPort(pod *corev1.Pod, ref PortRef) (int, error) {
	if n, ok := ref.Number(); ok {
		return n, nil
	}
	for _, c := range pod.Spec.Containers {
		for _, p := range c.Ports {
			if p.Name == string(ref) {
				return int(p.ContainerPort), nil
			}
		}
	}
	return 0, fmt.Errorf("pod %s/%s has no container port named %q", pod.Namespace, pod.Name, string(ref))
}

func isPodReady(pod *corev1.Pod) bool {
	if pod.DeletionTimestamp != nil || pod.Status.Phase != corev1.PodRunning {
		return false
	}
	for _, c := range pod.Status.Conditions {
		if c.Type == corev1.PodReady {
			return c.Status == corev1.ConditionTrue
		}
	}
	return false
}

// pickReadyPod returns a deterministic ready pod (oldest first, then by name)
// or nil when none is ready.
func pickReadyPod(pods []corev1.Pod) *corev1.Pod {
	ready := make([]*corev1.Pod, 0, len(pods))
	for i := range pods {
		if isPodReady(&pods[i]) {
			ready = append(ready, &pods[i])
		}
	}
	if len(ready) == 0 {
		return nil
	}
	sort.Slice(ready, func(i, j int) bool {
		a, b := ready[i].CreationTimestamp, ready[j].CreationTimestamp
		if !a.Equal(&b) {
			return a.Before(&b)
		}
		return ready[i].Name < ready[j].Name
	})
	return ready[0]
}

// SuggestPort returns a sensible default remote port for a target: the first
// service port, or the first declared container port. It returns 0 when the
// target declares no ports.
func SuggestPort(ctx context.Context, client kubernetes.Interface, kind, namespace, name string) (int, error) {
	switch kind {
	case KindService:
		svc, err := client.CoreV1().Services(namespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return 0, err
		}
		for _, p := range svc.Spec.Ports {
			if p.Port > 0 {
				return int(p.Port), nil
			}
		}
	case KindPod:
		pod, err := client.CoreV1().Pods(namespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return 0, err
		}
		for _, c := range pod.Spec.Containers {
			for _, p := range c.Ports {
				if p.ContainerPort > 0 {
					return int(p.ContainerPort), nil
				}
			}
		}
	default:
		return 0, fmt.Errorf("kind must be %q or %q", KindPod, KindService)
	}
	return 0, nil
}
