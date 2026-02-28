package server

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"path"
	"regexp"
	"strconv"
	"strings"

	"github.com/kroy/truss/backend/internal/kube"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/remotecommand"
)

// --- exec helper (no TTY, captures output synchronously) ---

func (s *Server) execInPod(ctx context.Context, cs *kube.ClientSet, namespace, pod, container string, cmd []string) ([]byte, error) {
	execReq := cs.Clientset.CoreV1().RESTClient().Post().
		Resource("pods").
		Name(pod).
		Namespace(namespace).
		SubResource("exec")

	opts := &corev1.PodExecOptions{
		Command: cmd,
		Stdin:   false,
		Stdout:  true,
		Stderr:  true,
		TTY:     false,
	}
	if container != "" {
		opts.Container = container
	}
	execReq.VersionedParams(opts, scheme.ParameterCodec)

	executor, err := remotecommand.NewSPDYExecutor(cs.Config, "POST", execReq.URL())
	if err != nil {
		return nil, fmt.Errorf("exec executor: %w", err)
	}

	var stdout, stderr bytes.Buffer
	err = executor.StreamWithContext(ctx, remotecommand.StreamOptions{
		Stdout: &stdout,
		Stderr: &stderr,
	})
	if err != nil {
		msg := stderr.String()
		if msg != "" {
			return nil, fmt.Errorf("%w: %s", err, strings.TrimSpace(msg))
		}
		return nil, err
	}
	return stdout.Bytes(), nil
}

// execInPodStream pipes stdin→container and container stdout→w (no TTY).
// Used for streaming download (stdin=nil) and upload (stdin=request body).
func (s *Server) execInPodStream(ctx context.Context, cs *kube.ClientSet, namespace, pod, container string, cmd []string, stdin io.Reader, stdout io.Writer) error {
	execReq := cs.Clientset.CoreV1().RESTClient().Post().
		Resource("pods").
		Name(pod).
		Namespace(namespace).
		SubResource("exec")

	opts := &corev1.PodExecOptions{
		Command: cmd,
		Stdin:   stdin != nil,
		Stdout:  true,
		Stderr:  true,
		TTY:     false,
	}
	if container != "" {
		opts.Container = container
	}
	execReq.VersionedParams(opts, scheme.ParameterCodec)

	executor, err := remotecommand.NewSPDYExecutor(cs.Config, "POST", execReq.URL())
	if err != nil {
		return fmt.Errorf("exec executor: %w", err)
	}

	var stderr bytes.Buffer
	streamOpts := remotecommand.StreamOptions{
		Stdout: stdout,
		Stderr: &stderr,
	}
	if stdin != nil {
		streamOpts.Stdin = stdin
	}

	err = executor.StreamWithContext(ctx, streamOpts)
	if err != nil {
		msg := stderr.String()
		if msg != "" {
			return fmt.Errorf("%w: %s", err, strings.TrimSpace(msg))
		}
		return err
	}
	return nil
}

// --- ls -la parser ---

// lsRe matches a single line of `ls -la` output.
// Groups: (1) mode string, (2) size in bytes, (3) filename (may include " -> target" for symlinks)
var lsRe = regexp.MustCompile(`^([dl\-][rwxstST\-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.+)$`)

type fileEntry struct {
	Name     string `json:"name"`
	IsDir    bool   `json:"isDir"`
	IsLink   bool   `json:"isLink"`
	Size     int64  `json:"size"`
	Modified string `json:"modified,omitempty"`
}

func parseLsOutput(output string) []fileEntry {
	var entries []fileEntry
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" || strings.HasPrefix(line, "total ") {
			continue
		}
		m := lsRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		mode := m[1]
		size, _ := strconv.ParseInt(m[2], 10, 64)
		name := m[3]

		isDir := mode[0] == 'd'
		isLink := mode[0] == 'l'

		// Strip symlink target: "name -> target"
		if isLink {
			if idx := strings.Index(name, " -> "); idx >= 0 {
				name = name[:idx]
			}
		}

		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}

		entries = append(entries, fileEntry{
			Name:   name,
			IsDir:  isDir,
			IsLink: isLink,
			Size:   size,
		})
	}
	return entries
}

// --- HTTP handlers ---

// handleFileList lists a directory inside a pod container.
// GET /api/file/list?context=&namespace=&pod=&container=&path=
func (s *Server) handleFileList() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		ctxName := q.Get("context")
		if ctxName == "" {
			ctxName = s.kubeMgr.ActiveContext()
		}
		namespace := q.Get("namespace")
		pod := q.Get("pod")
		container := q.Get("container")
		dirPath := q.Get("path")
		if dirPath == "" {
			dirPath = "/"
		}

		if pod == "" || namespace == "" {
			http.Error(w, "pod and namespace required", http.StatusBadRequest)
			return
		}

		cs, err := s.kubeMgr.GetClientSet(ctxName)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		// Run: ls -la -- <path>
		out, err := s.execInPod(r.Context(), cs, namespace, pod, container, []string{"ls", "-la", "--", dirPath})
		if err != nil {
			http.Error(w, fmt.Sprintf("ls failed: %v", err), http.StatusInternalServerError)
			return
		}

		entries := parseLsOutput(string(out))

		// Ensure ".." always appears (some containers/dirs may not show it via ls -la).
		// Remove it from parsed entries first to avoid duplicates.
		var filtered []fileEntry
		hasParent := false
		for _, e := range entries {
			if e.Name == ".." {
				hasParent = true
				filtered = append(filtered, e)
			} else if e.Name != "." {
				filtered = append(filtered, e)
			}
		}
		if !hasParent && dirPath != "/" {
			filtered = append([]fileEntry{{Name: "..", IsDir: true}}, filtered...)
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"path":    dirPath,
			"entries": filtered,
		})
	}
}

// handleFileDownload streams a file from a pod container to the client.
// GET /api/file/download?context=&namespace=&pod=&container=&path=
func (s *Server) handleFileDownload() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		ctxName := q.Get("context")
		if ctxName == "" {
			ctxName = s.kubeMgr.ActiveContext()
		}
		namespace := q.Get("namespace")
		pod := q.Get("pod")
		container := q.Get("container")
		filePath := q.Get("path")

		if pod == "" || namespace == "" || filePath == "" {
			http.Error(w, "pod, namespace and path required", http.StatusBadRequest)
			return
		}

		cs, err := s.kubeMgr.GetClientSet(ctxName)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		// Try to get file size for Content-Length (best effort).
		if sizeOut, err := s.execInPod(r.Context(), cs, namespace, pod, container,
			[]string{"stat", "-c", "%s", "--", filePath}); err == nil {
			if size, err := strconv.ParseInt(strings.TrimSpace(string(sizeOut)), 10, 64); err == nil && size >= 0 {
				w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
			}
		}

		filename := path.Base(filePath)
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename=%q`, filename))

		if err := s.execInPodStream(r.Context(), cs, namespace, pod, container,
			[]string{"cat", "--", filePath}, nil, w); err != nil {
			// Headers already sent; log but can't send HTTP error.
			fmt.Printf("file download error: %v\n", err)
		}
	}
}

// handleFileUpload writes request body bytes to a path inside a pod container.
// POST /api/file/upload?context=&namespace=&pod=&container=&path=
func (s *Server) handleFileUpload() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST required", http.StatusMethodNotAllowed)
			return
		}
		q := r.URL.Query()
		ctxName := q.Get("context")
		if ctxName == "" {
			ctxName = s.kubeMgr.ActiveContext()
		}
		namespace := q.Get("namespace")
		pod := q.Get("pod")
		container := q.Get("container")
		destPath := q.Get("path")

		if pod == "" || namespace == "" || destPath == "" {
			http.Error(w, "pod, namespace and path required", http.StatusBadRequest)
			return
		}

		cs, err := s.kubeMgr.GetClientSet(ctxName)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		// Write stdin to destination file. We pass the path as $1 to avoid shell quoting issues.
		cmd := []string{"sh", "-c", `cat > "$1"`, "upload", destPath}

		// Discard container stdout (cat echoes nothing; this is just for the io.Writer requirement).
		if err := s.execInPodStream(r.Context(), cs, namespace, pod, container,
			cmd, r.Body, io.Discard); err != nil {
			http.Error(w, fmt.Sprintf("upload failed: %v", err), http.StatusInternalServerError)
			return
		}

		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}

// handleFileMkdir creates a directory inside a pod container.
// POST /api/file/mkdir?context=&namespace=&pod=&container=&path=
func (s *Server) handleFileMkdir() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		ctxName := q.Get("context")
		if ctxName == "" {
			ctxName = s.kubeMgr.ActiveContext()
		}
		namespace := q.Get("namespace")
		pod := q.Get("pod")
		container := q.Get("container")
		dirPath := q.Get("path")

		if pod == "" || namespace == "" || dirPath == "" {
			http.Error(w, "pod, namespace and path required", http.StatusBadRequest)
			return
		}

		cs, err := s.kubeMgr.GetClientSet(ctxName)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		if _, err := s.execInPod(r.Context(), cs, namespace, pod, container,
			[]string{"mkdir", "-p", "--", dirPath}); err != nil {
			http.Error(w, fmt.Sprintf("mkdir failed: %v", err), http.StatusInternalServerError)
			return
		}

		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}

