package tools

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestStripHTML(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"<span>(<i>Smith et al.</i>, 2024)</span>", "(Smith et al., 2024)"},
		{"<div class=\"csl-entry\">Smith, J. (2024). <i>Test Title</i>. &amp; More</div>", "Smith, J. (2024). Test Title. & More"},
		{"Plain text", "Plain text"},
	}

	for _, c := range cases {
		got := stripHTML(c.in)
		if got != c.want {
			t.Errorf("stripHTML(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestZoteroCollectionsTool(t *testing.T) {
	// Mock server
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Zotero-API-Key") != "mock_key" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		data := []map[string]any{
			{
				"key": "COL1",
				"meta": map[string]any{
					"numCollections": 0,
					"numItems":       5,
				},
				"data": map[string]any{
					"name": "Machine Learning",
				},
			},
		}
		_ = json.NewEncoder(w).Encode(data)
	}))
	defer mockServer.Close()

	tool := zoteroCollectionsTool{}
	if tool.Name() != "zotero_collections" {
		t.Errorf("expected tool name zotero_collections, got %s", tool.Name())
	}
	if tool.RequiresApproval() != false {
		t.Errorf("expected RequiresApproval to be false")
	}
}

func TestZoteroCiteToolSchema(t *testing.T) {
	tool := zoteroCiteTool{}
	if tool.Name() != "zotero_cite" {
		t.Errorf("expected zotero_cite, got %s", tool.Name())
	}
	schema := tool.Schema()
	props, ok := schema["properties"].(map[string]any)
	if !ok {
		t.Fatalf("expected properties in schema")
	}
	if _, ok := props["format"]; !ok {
		t.Errorf("expected format property in schema")
	}
}
