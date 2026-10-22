package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/enowdev/antares/internal/config"
)

func editorTestServer(t *testing.T) (*Server, string) {
	t.Helper()
	t.Setenv("ANTARES_HOME", t.TempDir())
	cfg := config.Default()
	root := t.TempDir()
	cfg.Agent.Workspace = root
	cfg.Server.DashboardPasswordHash = "test-hash"
	return &Server{cfg: cfg}, root
}

func writeFileRequest(t *testing.T, s *Server, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/files/write", bytes.NewReader(raw))
	rr := httptest.NewRecorder()
	s.handleWriteFile(rr, req)
	return rr
}

func TestWriteFileSavesAndReturnsMtime(t *testing.T) {
	s, root := editorTestServer(t)
	path := filepath.Join(root, "main.go")
	if err := os.WriteFile(path, []byte("package main\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}

	rr := writeFileRequest(t, s, map[string]any{
		"path": "main.go", "content": "package main\n\nfunc main() {}\n",
		"expected_mtime": fi.ModTime().UnixMilli(),
	})
	if rr.Code != http.StatusOK {
		t.Fatalf("save status = %d, body = %s", rr.Code, rr.Body.String())
	}
	if got, _ := os.ReadFile(path); string(got) != "package main\n\nfunc main() {}\n" {
		t.Fatalf("file contents = %q", got)
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o640 {
		t.Fatalf("mode = %v, want 0640", info.Mode().Perm())
	}
	var res map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if _, ok := res["mtime"].(float64); !ok {
		t.Fatalf("response has no numeric mtime: %v", res)
	}
}

func TestWriteFileRefusesStaleMtime(t *testing.T) {
	s, root := editorTestServer(t)
	path := filepath.Join(root, "stale.txt")
	if err := os.WriteFile(path, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	rr := writeFileRequest(t, s, map[string]any{
		"path": "stale.txt", "content": "new", "expected_mtime": 1,
	})
	if rr.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rr.Code)
	}
	if got, _ := os.ReadFile(path); string(got) != "old" {
		t.Fatalf("stale save clobbered the file: %q", got)
	}
}

func TestWriteFileRejectsTraversalAndSymlinkEscape(t *testing.T) {
	s, root := editorTestServer(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(root, "link.txt")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}

	for _, path := range []string{"../secret.txt", filepath.Join(outside, "secret.txt"), "link.txt"} {
		rr := writeFileRequest(t, s, map[string]any{"path": path, "content": "pwned"})
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, body = %s", path, rr.Code, rr.Body.String())
		}
	}
	if got, _ := os.ReadFile(filepath.Join(outside, "secret.txt")); string(got) != "secret" {
		t.Fatalf("outside file was modified: %q", got)
	}
}

func TestWriteFileRejectsBinaryAndOversize(t *testing.T) {
	s, root := editorTestServer(t)
	path := filepath.Join(root, "a.txt")
	if err := os.WriteFile(path, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}

	if rr := writeFileRequest(t, s, map[string]any{"path": "a.txt", "content": "a\x00b"}); rr.Code != http.StatusBadRequest {
		t.Fatalf("binary status = %d, want 400", rr.Code)
	}
	big := strings.Repeat("a", maxEditableFile+1)
	if rr := writeFileRequest(t, s, map[string]any{"path": "a.txt", "content": big}); rr.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize status = %d, want 413", rr.Code)
	}
}

func TestWriteFileRequiresPasswordAndExistingFile(t *testing.T) {
	t.Setenv("ANTARES_HOME", t.TempDir())
	cfg := config.Default()
	cfg.Agent.Workspace = t.TempDir()
	s := &Server{cfg: cfg}

	rr := writeFileRequest(t, s, map[string]any{"path": "x.txt", "content": "x"})
	if rr.Code != http.StatusPreconditionRequired {
		t.Fatalf("unprotected status = %d, want 428", rr.Code)
	}

	cfg.Server.DashboardPasswordHash = "test-hash"
	rr = writeFileRequest(t, s, map[string]any{"path": "missing.txt", "content": "x"})
	if rr.Code != http.StatusNotFound {
		t.Fatalf("missing file status = %d, want 404", rr.Code)
	}
	if _, err := os.Stat(filepath.Join(cfg.Agent.Workspace, "missing.txt")); !os.IsNotExist(err) {
		t.Fatal("write created a new file")
	}
}
