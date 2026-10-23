package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

func fileOpRequest(t *testing.T, s *Server, method, target string, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(raw)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, target, reader)
	rr := httptest.NewRecorder()
	switch {
	case target == "/api/files/create":
		s.handleCreateFile(rr, req)
	case target == "/api/files/rename":
		s.handleRenameFile(rr, req)
	case method == http.MethodDelete:
		s.handleDeleteFile(rr, req)
	default:
		t.Fatalf("unhandled target %s", target)
	}
	return rr
}

func TestCreateFileAndDirectory(t *testing.T) {
	s, root := editorTestServer(t)

	rr := fileOpRequest(t, s, http.MethodPost, "/api/files/create", map[string]any{"path": "src", "type": "dir"})
	if rr.Code != http.StatusOK {
		t.Fatalf("create dir status = %d, body = %s", rr.Code, rr.Body.String())
	}
	if fi, err := os.Stat(filepath.Join(root, "src")); err != nil || !fi.IsDir() {
		t.Fatalf("src was not created as a directory: %v", err)
	}

	rr = fileOpRequest(t, s, http.MethodPost, "/api/files/create", map[string]any{"path": "src/main.go", "type": "file"})
	if rr.Code != http.StatusOK {
		t.Fatalf("create file status = %d, body = %s", rr.Code, rr.Body.String())
	}
	fi, err := os.Stat(filepath.Join(root, "src", "main.go"))
	if err != nil {
		t.Fatal(err)
	}
	if fi.IsDir() || fi.Mode().Perm() != 0o644 {
		t.Fatalf("mode = %v, want regular 0644", fi.Mode())
	}
	var res map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res["path"] != "src/main.go" {
		t.Fatalf("path = %v, want src/main.go", res["path"])
	}

	if rr := fileOpRequest(t, s, http.MethodPost, "/api/files/create", map[string]any{"path": "src/main.go", "type": "file"}); rr.Code != http.StatusConflict {
		t.Fatalf("duplicate status = %d, want 409", rr.Code)
	}
	if rr := fileOpRequest(t, s, http.MethodPost, "/api/files/create", map[string]any{"path": "missing/x.txt", "type": "file"}); rr.Code != http.StatusBadRequest {
		t.Fatalf("missing parent status = %d, want 400", rr.Code)
	}
	if rr := fileOpRequest(t, s, http.MethodPost, "/api/files/create", map[string]any{"path": "x.txt", "type": "socket"}); rr.Code != http.StatusBadRequest {
		t.Fatalf("bad type status = %d, want 400", rr.Code)
	}
	if rr := fileOpRequest(t, s, http.MethodPost, "/api/files/create", map[string]any{"path": "../escape.txt", "type": "file"}); rr.Code != http.StatusBadRequest {
		t.Fatalf("traversal status = %d, want 400", rr.Code)
	}
}

func TestCreateRejectsSymlinkedParentEscape(t *testing.T) {
	s, root := editorTestServer(t)
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "out")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	rr := fileOpRequest(t, s, http.MethodPost, "/api/files/create", map[string]any{"path": "out/pwned.txt", "type": "file"})
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body = %s", rr.Code, rr.Body.String())
	}
	if _, err := os.Stat(filepath.Join(outside, "pwned.txt")); !os.IsNotExist(err) {
		t.Fatalf("file escaped the workspace")
	}
}

func TestRenameFileAndDirectory(t *testing.T) {
	s, root := editorTestServer(t)
	if err := os.WriteFile(filepath.Join(root, "old.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	rr := fileOpRequest(t, s, http.MethodPost, "/api/files/rename", map[string]any{"path": "old.txt", "name": "new.txt"})
	if rr.Code != http.StatusOK {
		t.Fatalf("rename status = %d, body = %s", rr.Code, rr.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "new.txt")); err != nil {
		t.Fatalf("new name missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "old.txt")); !os.IsNotExist(err) {
		t.Fatalf("old name still exists")
	}

	if err := os.Mkdir(filepath.Join(root, "dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "dir", "a.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if rr := fileOpRequest(t, s, http.MethodPost, "/api/files/rename", map[string]any{"path": "dir", "name": "renamed"}); rr.Code != http.StatusOK {
		t.Fatalf("dir rename status = %d", rr.Code)
	}
	if _, err := os.Stat(filepath.Join(root, "renamed", "a.txt")); err != nil {
		t.Fatalf("directory rename lost contents: %v", err)
	}

	if rr := fileOpRequest(t, s, http.MethodPost, "/api/files/rename", map[string]any{"path": "new.txt", "name": "renamed"}); rr.Code != http.StatusConflict {
		t.Fatalf("collision status = %d, want 409", rr.Code)
	}
	if rr := fileOpRequest(t, s, http.MethodPost, "/api/files/rename", map[string]any{"path": "new.txt", "name": "../escape.txt"}); rr.Code != http.StatusBadRequest {
		t.Fatalf("separator name status = %d, want 400", rr.Code)
	}
	if rr := fileOpRequest(t, s, http.MethodPost, "/api/files/rename", map[string]any{"path": "missing.txt", "name": "x.txt"}); rr.Code != http.StatusNotFound {
		t.Fatalf("missing source status = %d, want 404", rr.Code)
	}
}

func TestDeleteFileAndDirectory(t *testing.T) {
	s, root := editorTestServer(t)
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if rr := fileOpRequest(t, s, http.MethodDelete, "/api/files?path="+url.QueryEscape("a.txt"), nil); rr.Code != http.StatusOK {
		t.Fatalf("delete file status = %d, body = %s", rr.Code, rr.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "a.txt")); !os.IsNotExist(err) {
		t.Fatalf("file still exists")
	}

	if err := os.MkdirAll(filepath.Join(root, "tree", "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "tree", "nested", "x.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	target := "/api/files?path=" + url.QueryEscape("tree")
	if rr := fileOpRequest(t, s, http.MethodDelete, target, nil); rr.Code != http.StatusConflict {
		t.Fatalf("non-recursive delete status = %d, want 409", rr.Code)
	}
	if _, err := os.Stat(filepath.Join(root, "tree")); err != nil {
		t.Fatalf("non-recursive delete removed the tree: %v", err)
	}
	if rr := fileOpRequest(t, s, http.MethodDelete, target+"&recursive=1", nil); rr.Code != http.StatusOK {
		t.Fatalf("recursive delete status = %d, body = %s", rr.Code, rr.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "tree")); !os.IsNotExist(err) {
		t.Fatalf("tree still exists")
	}

	if rr := fileOpRequest(t, s, http.MethodDelete, "/api/files?path="+url.QueryEscape(".."), nil); rr.Code != http.StatusBadRequest {
		t.Fatalf("root delete status = %d, want 400", rr.Code)
	}
}
