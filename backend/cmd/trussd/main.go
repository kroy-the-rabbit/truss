package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/kroy/truss/backend/internal/auth"
	"github.com/kroy/truss/backend/internal/contextstore"
	"github.com/kroy/truss/backend/internal/kube"
	"github.com/kroy/truss/backend/internal/server"
)

// version is set at build time via -ldflags="-X main.version=<tag>"
var version = "dev"

func main() {
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
	port, err := srv.Start(token)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to start server: %v\n", err)
		os.Exit(1)
	}

	// Print port and token for the Electron process to read.
	fmt.Printf("TRUSS_PORT=%d\n", port)
	fmt.Printf("TRUSS_TOKEN=%s\n", token)

	// Wait for termination signal.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh
	fmt.Println("shutting down")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Stop(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "server shutdown error: %v\n", err)
	}
}
