package main

import (
	"errors"
	"io"
	"os"
	"testing"
	"time"
)

func TestMainTokenFromEnv(t *testing.T) {
	t.Setenv("TRUSS_MAIN_TOKEN", "0123456789abcdef0123456789abcdef")
	if got := mainTokenFromEnv(); got != "0123456789abcdef0123456789abcdef" {
		t.Fatalf("got %q", got)
	}
	if _, ok := os.LookupEnv("TRUSS_MAIN_TOKEN"); ok {
		t.Fatal("TRUSS_MAIN_TOKEN should be removed from the environment")
	}
	t.Setenv("TRUSS_MAIN_TOKEN", "short")
	if got := mainTokenFromEnv(); got != "" {
		t.Fatalf("short token should disable, got %q", got)
	}
}

func TestWatchStdinEOFFiresOnClose(t *testing.T) {
	pr, pw := io.Pipe()
	fired := make(chan struct{})
	go watchStdinEOF(pr, func() { close(fired) })

	// Data on stdin must not trigger shutdown.
	if _, err := pw.Write([]byte("keepalive\n")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-fired:
		t.Fatal("fired before EOF")
	case <-time.After(50 * time.Millisecond):
	}

	_ = pw.Close()
	select {
	case <-fired:
	case <-time.After(2 * time.Second):
		t.Fatal("did not fire on EOF")
	}
}

func TestWatchStdinEOFFiresOnReadError(t *testing.T) {
	pr, pw := io.Pipe()
	fired := make(chan struct{})
	go watchStdinEOF(pr, func() { close(fired) })
	_ = pw.CloseWithError(errors.New("broken pipe"))
	select {
	case <-fired:
	case <-time.After(2 * time.Second):
		t.Fatal("did not fire on read error")
	}
}
