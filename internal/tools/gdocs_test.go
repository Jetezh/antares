package tools

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGDocsTools(t *testing.T) {
	AllowInsecureTestWebhook = true
	defer func() { AllowInsecureTestWebhook = false }()

	// Mock server for Google Apps Script Webhook
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status":  "success",
				"title":   "Proposal Penelitian",
				"content": "Ini adalah draf awal proposal.",
			})
			return
		}
		if r.Method == "POST" {
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status":  "success",
				"message": "Content appended successfully",
			})
			return
		}
	}))
	defer mockServer.Close()

	readTool := gdocsReadTool{}
	if readTool.Name() != "gdocs_read" {
		t.Errorf("expected gdocs_read, got %s", readTool.Name())
	}
	if readTool.RequiresApproval() != false {
		t.Errorf("expected RequiresApproval to be false for readTool")
	}

	updateTool := gdocsUpdateTool{}
	if updateTool.Name() != "gdocs_update" {
		t.Errorf("expected gdocs_update, got %s", updateTool.Name())
	}
	if updateTool.RequiresApproval() != true {
		t.Errorf("expected RequiresApproval to be true for updateTool")
	}

	// Test read execution
	readRes := readTool.Execute(context.Background(), Input{
		Args: json.RawMessage(`{"webhook_url":"` + mockServer.URL + `"}`),
	})
	if readRes.IsError {
		t.Fatalf("expected successful read, got error: %s", readRes.Content)
	}

	// Test update execution
	updateRes := updateTool.Execute(context.Background(), Input{
		Args: json.RawMessage(`{"webhook_url":"` + mockServer.URL + `", "text":"Paragraf baru dengan sitasi", "citations":["(Setiawan, 2024)"]}`),
	})
	if updateRes.IsError {
		t.Fatalf("expected successful update, got error: %s", updateRes.Content)
	}
}
