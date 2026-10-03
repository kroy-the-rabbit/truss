package portforward

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/kubernetes/fake"
)

func testPod(name string, ready bool, created time.Time, ports ...corev1.ContainerPort) *corev1.Pod {
	status := corev1.ConditionFalse
	if ready {
		status = corev1.ConditionTrue
	}
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:              name,
			Namespace:         "ns",
			Labels:            map[string]string{"app": "web"},
			CreationTimestamp: metav1.NewTime(created),
		},
		Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "c", Ports: ports}}},
		Status: corev1.PodStatus{
			Phase:      corev1.PodRunning,
			Conditions: []corev1.PodCondition{{Type: corev1.PodReady, Status: status}},
		},
	}
}

func testService(ports ...corev1.ServicePort) *corev1.Service {
	return &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "ns"},
		Spec: corev1.ServiceSpec{
			Selector: map[string]string{"app": "web"},
			Ports:    ports,
		},
	}
}

func svcTarget(port string) Target {
	return Target{Context: "c", Namespace: "ns", Kind: KindService, Name: "web", RemotePort: PortRef(port)}
}

func TestResolveServiceNumericTargetPort(t *testing.T) {
	now := time.Now()
	client := fake.NewClientset(
		testService(corev1.ServicePort{Name: "http", Port: 80, TargetPort: intstr.FromInt32(8080)}),
		testPod("web-b", true, now),
		testPod("web-a", true, now.Add(time.Minute)),
	)
	got, err := Resolve(context.Background(), client, svcTarget("80"))
	if err != nil {
		t.Fatal(err)
	}
	// Oldest ready pod wins.
	if got.Pod != "web-b" || got.Port != 8080 {
		t.Fatalf("got %+v, want web-b:8080", got)
	}
}

func TestResolveServiceNamedTargetPort(t *testing.T) {
	now := time.Now()
	client := fake.NewClientset(
		testService(corev1.ServicePort{Name: "web", Port: 80, TargetPort: intstr.FromString("http-alt")}),
		testPod("web-0", true, now,
			corev1.ContainerPort{Name: "metrics", ContainerPort: 9090},
			corev1.ContainerPort{Name: "http-alt", ContainerPort: 8081}),
	)
	// Service port selected by name.
	got, err := Resolve(context.Background(), client, svcTarget("web"))
	if err != nil {
		t.Fatal(err)
	}
	if got.Pod != "web-0" || got.Port != 8081 {
		t.Fatalf("got %+v, want web-0:8081", got)
	}
}

func TestResolveServiceNamedTargetPortMissingOnPod(t *testing.T) {
	client := fake.NewClientset(
		testService(corev1.ServicePort{Port: 80, TargetPort: intstr.FromString("nope")}),
		testPod("web-0", true, time.Now()),
	)
	_, err := Resolve(context.Background(), client, svcTarget("80"))
	if err == nil || !strings.Contains(err.Error(), `"nope"`) {
		t.Fatalf("err = %v", err)
	}
}

func TestResolveServiceUnsetTargetPortUsesPort(t *testing.T) {
	client := fake.NewClientset(
		testService(corev1.ServicePort{Port: 5432}),
		testPod("db-0", true, time.Now()),
	)
	got, err := Resolve(context.Background(), client, svcTarget("5432"))
	if err != nil {
		t.Fatal(err)
	}
	if got.Port != 5432 {
		t.Fatalf("port = %d", got.Port)
	}
}

func TestResolveServiceNoReadyPods(t *testing.T) {
	deleting := testPod("web-1", true, time.Now())
	now := metav1.Now()
	deleting.DeletionTimestamp = &now
	deleting.Finalizers = []string{"x"}
	pending := testPod("web-2", true, time.Now())
	pending.Status.Phase = corev1.PodPending
	client := fake.NewClientset(
		testService(corev1.ServicePort{Port: 80, TargetPort: intstr.FromInt32(8080)}),
		testPod("web-0", false, time.Now()),
		deleting,
		pending,
	)
	_, err := Resolve(context.Background(), client, svcTarget("80"))
	if err == nil || !strings.Contains(err.Error(), "no ready pods") {
		t.Fatalf("err = %v", err)
	}
}

func TestResolveServiceErrors(t *testing.T) {
	noSelector := testService(corev1.ServicePort{Port: 80})
	noSelector.Spec.Selector = nil
	cases := []struct {
		name    string
		objs    []runtime.Object
		port    string
		wantErr string
	}{
		{"missing service", nil, "80", "getting service"},
		{"no selector", []runtime.Object{noSelector}, "80", "no pod selector"},
		{"unknown port", []runtime.Object{testService(corev1.ServicePort{Port: 80})}, "81", "does not expose port 81"},
		{"unknown port name", []runtime.Object{testService(corev1.ServicePort{Name: "http", Port: 80})}, "grpc", `no port named "grpc"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Resolve(context.Background(), fake.NewClientset(tc.objs...), svcTarget(tc.port))
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("err = %v, want %q", err, tc.wantErr)
			}
		})
	}
}

func TestResolvePod(t *testing.T) {
	pod := testPod("p", true, time.Now(), corev1.ContainerPort{Name: "http", ContainerPort: 3000})
	client := fake.NewClientset(pod)
	podTarget := func(port string) Target {
		return Target{Namespace: "ns", Kind: KindPod, Name: "p", RemotePort: PortRef(port)}
	}
	got, err := Resolve(context.Background(), client, podTarget("8080"))
	if err != nil || got != (Resolved{Pod: "p", Port: 8080}) {
		t.Fatalf("numeric: %+v %v", got, err)
	}
	got, err = Resolve(context.Background(), client, podTarget("http"))
	if err != nil || got.Port != 3000 {
		t.Fatalf("named: %+v %v", got, err)
	}
	if _, err := Resolve(context.Background(), client, podTarget("grpc")); err == nil {
		t.Fatal("expected error for unknown named port")
	}

	pod.Status.Phase = corev1.PodSucceeded
	if _, err := Resolve(context.Background(), fake.NewClientset(pod), podTarget("80")); err == nil ||
		!strings.Contains(err.Error(), "not running") {
		t.Fatalf("err = %v", err)
	}
}

func TestTargetValidation(t *testing.T) {
	bad := []Target{
		{Namespace: "", Kind: KindPod, Name: "p", RemotePort: "80"},
		{Namespace: "ns", Kind: "deployment", Name: "p", RemotePort: "80"},
		{Namespace: "ns", Kind: KindPod, Name: "p", RemotePort: ""},
		{Namespace: "ns", Kind: KindPod, Name: "p", RemotePort: "70000"},
		{Namespace: "ns", Kind: KindPod, Name: "p", RemotePort: "Bad_Name"},
	}
	for _, tgt := range bad {
		if err := tgt.validate(); err == nil {
			t.Errorf("expected validation error for %+v", tgt)
		}
	}
}

func TestPortRefJSON(t *testing.T) {
	var v struct {
		A PortRef `json:"a"`
		B PortRef `json:"b"`
		C PortRef `json:"c"`
	}
	if err := json.Unmarshal([]byte(`{"a":8080,"b":"http","c":"9090"}`), &v); err != nil {
		t.Fatal(err)
	}
	if v.A != "8080" || v.B != "http" || v.C != "9090" {
		t.Fatalf("got %+v", v)
	}
	out, _ := json.Marshal(v)
	if string(out) != `{"a":8080,"b":"http","c":9090}` {
		t.Fatalf("marshal = %s", out)
	}
	if err := json.Unmarshal([]byte(`{"a":true}`), &v); err == nil {
		t.Fatal("expected error for bool port")
	}
}

func TestSuggestPort(t *testing.T) {
	client := fake.NewClientset(
		testService(corev1.ServicePort{Port: 443}, corev1.ServicePort{Port: 80}),
		testPod("p", true, time.Now(), corev1.ContainerPort{ContainerPort: 9000}),
		testPod("bare", true, time.Now()),
	)
	ctx := context.Background()
	if p, err := SuggestPort(ctx, client, KindService, "ns", "web"); err != nil || p != 443 {
		t.Fatalf("service: %d %v", p, err)
	}
	if p, err := SuggestPort(ctx, client, KindPod, "ns", "p"); err != nil || p != 9000 {
		t.Fatalf("pod: %d %v", p, err)
	}
	if p, err := SuggestPort(ctx, client, KindPod, "ns", "bare"); err != nil || p != 0 {
		t.Fatalf("bare pod: %d %v", p, err)
	}
	if _, err := SuggestPort(ctx, client, KindPod, "ns", "missing"); err == nil {
		t.Fatal("expected error for missing pod")
	}
}
