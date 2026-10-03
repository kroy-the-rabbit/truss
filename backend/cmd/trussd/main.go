package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/kroy/truss/backend/internal/auth"
	"github.com/kroy/truss/backend/internal/contextstore"
	"github.com/kroy/truss/backend/internal/kube"
	"github.com/kroy/truss/backend/internal/server"
)

// mainTokenFromEnv reads the Electron-main-only credential and removes it from
// the environment so child processes (exec credential plugins, helm, etc.)
// never inherit it. A missing or too-short token disables main-only endpoints.
func mainTokenFromEnv() string {
	tok := os.Getenv("TRUSS_MAIN_TOKEN")
	_ = os.Unsetenv("TRUSS_MAIN_TOKEN")
	if len(tok) < 32 {
		return ""
	}
	return tok
}

// version is set at build time via -ldflags="-X main.version=<tag>"
var version = "dev"

// watchStdinEOF reads r until EOF or a read error, then calls onEOF. With
// --exit-on-stdin-eof the parent (Electron) holds our stdin pipe open; when
// the parent dies the pipe closes and the daemon shuts down instead of being
// orphaned.
func watchStdinEOF(r io.Reader, onEOF func()) {
	_, _ = io.Copy(io.Discard, r)
	onEOF()
}

func main() {
	exitOnStdinEOF := flag.Bool("exit-on-stdin-eof", false, "shut down gracefully when stdin reaches EOF (parent process exited)")
	flag.Parse()

	// Generate or use provided auth token.
	token := os.Getenv("TRUSS_TOKEN")
	if token == "" {
		var err error
		token, err = auth.GenerateToken()
		if err != nil {
			fmt.Fprintf(os.Stderr, "failed to generate token: %v\n", err)
			os.Exit(1)
		}
	}

	// Initialize encrypted context store.
	store, err := contextstore.New()
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to init context store: %v\n", err)
		os.Exit(1)
	}

	// Create kube manager backed by the store.
	kubeMgr := kube.NewManager(store)

	// Start server.
	srv := server.New(kubeMgr, store, version)
	srv.SetMainToken(mainTokenFromEnv())
	port, err := srv.Start(token)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to start server: %v\n", err)
		os.Exit(1)
	}

	// Print port and token for the Electron process to read.
	fmt.Printf("TRUSS_PORT=%d\n", port)
	fmt.Printf("TRUSS_TOKEN=%s\n", token)

	// Wait for a termination signal (or stdin EOF when requested).
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	stdinEOF := make(chan struct{})
	if *exitOnStdinEOF {
		go watchStdinEOF(os.Stdin, func() { close(stdinEOF) })
	}
	select {
	case <-sigCh:
	case <-stdinEOF:
		fmt.Fprintln(os.Stderr, "stdin closed; parent exited")
	}
	fmt.Println("shutting down")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Stop(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "server shutdown error: %v\n", err)
	}
}
