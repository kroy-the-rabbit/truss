package portforward

import (
	"fmt"
	"net/http"

	"k8s.io/apimachinery/pkg/util/httpstream"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/portforward"
	"k8s.io/client-go/transport/spdy"
)

// BuildDialer builds the dialer for a pod's portforward subresource from the
// context's rest config, preferring SPDY-over-WebSocket and falling back to
// plain SPDY like kubectl. It does not open a connection.
func BuildDialer(cfg *rest.Config, rc rest.Interface, namespace, pod string) (httpstream.Dialer, error) {
	if cfg == nil || rc == nil {
		return nil, fmt.Errorf("missing kubernetes client configuration")
	}
	// Forwards are long-lived; the client-wide request timeout must not apply.
	streamCfg := rest.CopyConfig(cfg)
	streamCfg.Timeout = 0

	u := rc.Post().
		Resource("pods").
		Namespace(namespace).
		Name(pod).
		SubResource("portforward").
		URL()

	transport, upgrader, err := spdy.RoundTripperFor(streamCfg)
	if err != nil {
		return nil, fmt.Errorf("building spdy transport: %w", err)
	}
	spdyDialer := spdy.NewDialer(upgrader, &http.Client{Transport: transport}, http.MethodPost, u)

	wsDialer, err := portforward.NewSPDYOverWebsocketDialer(u, streamCfg)
	if err != nil {
		return nil, fmt.Errorf("building websocket dialer: %w", err)
	}
	return portforward.NewFallbackDialer(wsDialer, spdyDialer, func(err error) bool {
		return httpstream.IsUpgradeFailure(err) || httpstream.IsHTTPSProxyError(err)
	}), nil
}

// dialKube is the production DialFunc.
func dialKube(cfg *rest.Config, client kubernetes.Interface, namespace, pod string) (httpstream.Connection, error) {
	d, err := BuildDialer(cfg, client.CoreV1().RESTClient(), namespace, pod)
	if err != nil {
		return nil, err
	}
	conn, protocol, err := d.Dial(portforward.PortForwardProtocolV1Name)
	if err != nil {
		return nil, fmt.Errorf("connecting to pod %s/%s: %w", namespace, pod, err)
	}
	if protocol != portforward.PortForwardProtocolV1Name {
		_ = conn.Close()
		return nil, fmt.Errorf("unable to negotiate port-forward protocol (server returned %q)", protocol)
	}
	return conn, nil
}
