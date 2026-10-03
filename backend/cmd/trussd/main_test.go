package main

import (
	"errors"
	"io"
	"testing"
	"time"
)

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
