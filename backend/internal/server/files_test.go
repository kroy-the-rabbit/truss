package server

import (
	"testing"
)

func TestParseLsOutputRegularFiles(t *testing.T) {
	input := `total 32
-rw-r--r-- 1 root root   512 Jan 15 09:00 app.conf
-rwxr-xr-x 1 root root 16384 Jan 15 09:00 server
-rw------- 1 root root  1024 Jan 15 09:00 secret.key
`
	entries := parseLsOutput(input)
	if len(entries) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(entries))
	}

	names := map[string]fileEntry{}
	for _, e := range entries {
		names[e.Name] = e
	}

	appConf := names["app.conf"]
	if appConf.IsDir || appConf.IsLink || appConf.Size != 512 {
		t.Errorf("app.conf: isDir=%v isLink=%v size=%d", appConf.IsDir, appConf.IsLink, appConf.Size)
	}

	srv := names["server"]
	if srv.IsDir || srv.IsLink || srv.Size != 16384 {
		t.Errorf("server: isDir=%v isLink=%v size=%d", srv.IsDir, srv.IsLink, srv.Size)
	}

	sec := names["secret.key"]
	if sec.IsDir || sec.IsLink || sec.Size != 1024 {
		t.Errorf("secret.key: isDir=%v isLink=%v size=%d", sec.IsDir, sec.IsLink, sec.Size)
	}
}

func TestParseLsOutputDirectories(t *testing.T) {
	input := `total 8
drwxr-xr-x 2 root root 4096 Jan 15 09:00 bin
drwxr-xr-x 5 root root 4096 Jan 15 09:00 etc
`
	entries := parseLsOutput(input)
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(entries))
	}
	for _, e := range entries {
		if !e.IsDir {
			t.Errorf("expected %q to be a directory", e.Name)
		}
		if e.IsLink {
			t.Errorf("expected %q not to be a symlink", e.Name)
		}
	}
}

func TestParseLsOutputSymlinks(t *testing.T) {
	input := `total 4
lrwxrwxrwx 1 root root 7 Jan 15 09:00 lib -> lib64
lrwxrwxrwx 1 root root 4 Jan 15 09:00 run -> /run
`
	entries := parseLsOutput(input)
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries, got %d: %+v", len(entries), entries)
	}
	for _, e := range entries {
		if !e.IsLink {
			t.Errorf("expected %q to be a symlink", e.Name)
		}
		// Symlink target must be stripped from the name.
		if e.Name == "lib -> lib64" || e.Name == "run -> /run" {
			t.Errorf("symlink target not stripped from name: %q", e.Name)
		}
	}
	names := map[string]bool{}
	for _, e := range entries {
		names[e.Name] = true
	}
	if !names["lib"] || !names["run"] {
		t.Errorf("expected names 'lib' and 'run', got %v", names)
	}
}

// TestParseLsOutputDotEntries verifies that parseLsOutput passes through both
// "." and ".." entries — filtering them is the responsibility of the caller
// (handleFileList removes "." and conditionally synthesises "..").
func TestParseLsOutputDotEntries(t *testing.T) {
	input := `total 12
drwxr-xr-x 2 root root 4096 Jan 15 09:00 .
drwxr-xr-x 8 root root 4096 Jan 15 09:00 ..
-rw-r--r-- 1 root root  100 Jan 15 09:00 README.md
`
	entries := parseLsOutput(input)

	byName := map[string]fileEntry{}
	for _, e := range entries {
		byName[e.Name] = e
	}

	if _, ok := byName["."]; !ok {
		t.Error("parseLsOutput should include '.' — caller is responsible for filtering")
	}
	if _, ok := byName[".."]; !ok {
		t.Error("parseLsOutput should include '..'")
	}
	if _, ok := byName["README.md"]; !ok {
		t.Error("README.md should be present")
	}
}

func TestParseLsOutputSkipsBlankAndTotalLines(t *testing.T) {
	input := `
total 0

-rw-r--r-- 1 root root 10 Jan 15 09:00 file.txt

`
	entries := parseLsOutput(input)
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d: %+v", len(entries), entries)
	}
	if entries[0].Name != "file.txt" {
		t.Fatalf("expected 'file.txt', got %q", entries[0].Name)
	}
}

func TestParseLsOutputMixedTypes(t *testing.T) {
	input := `total 20
drwxr-xr-x 2 app  app  4096 Jan 15 09:00 conf.d
-rw-r--r-- 1 app  app   256 Jan 15 09:00 nginx.conf
lrwxrwxrwx 1 root root    7 Jan 15 09:00 logs -> /var/log
`
	entries := parseLsOutput(input)
	if len(entries) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(entries))
	}

	byName := map[string]fileEntry{}
	for _, e := range entries {
		byName[e.Name] = e
	}

	if !byName["conf.d"].IsDir {
		t.Error("conf.d should be a directory")
	}
	if byName["conf.d"].IsLink {
		t.Error("conf.d should not be a symlink")
	}
	if byName["nginx.conf"].IsDir || byName["nginx.conf"].IsLink {
		t.Error("nginx.conf should be a plain file")
	}
	if !byName["logs"].IsLink {
		t.Error("logs should be a symlink")
	}
	if byName["logs"].Name != "logs" {
		t.Errorf("logs symlink name should be 'logs', got %q", byName["logs"].Name)
	}
}

func TestParseLsOutputEmptyInput(t *testing.T) {
	entries := parseLsOutput("")
	if len(entries) != 0 {
		t.Fatalf("expected 0 entries for empty input, got %d", len(entries))
	}
}

func TestParseLsOutputWindowsLineEndings(t *testing.T) {
	// Some containers may return CRLF line endings.
	input := "total 4\r\n-rw-r--r-- 1 root root 42 Jan 15 09:00 data.txt\r\n"
	entries := parseLsOutput(input)
	if len(entries) != 1 || entries[0].Name != "data.txt" {
		t.Fatalf("expected ['data.txt'], got %+v", entries)
	}
}

func TestParseLsOutputFilenameWithSpaces(t *testing.T) {
	input := `-rw-r--r-- 1 root root 1024 Jan 15 09:00 my config file.conf`
	entries := parseLsOutput(input)
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if entries[0].Name != "my config file.conf" {
		t.Errorf("expected 'my config file.conf', got %q", entries[0].Name)
	}
}
