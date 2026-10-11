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

	// Test update execution with zotero_items and item_keys
	zoteroUpdateRes := updateTool.Execute(context.Background(), Input{
		Args: json.RawMessage(`{
			"webhook_url":"` + mockServer.URL + `",
			"text":"Paragraf dengan sitasi Zotero resmi [cite:UXDB5SN6]",
			"zotero_items": [
				{"key": "UXDB5SN6", "citation": "(Setiawan, 2024)", "title": "Penelitian Antares"}
			]
		}`),
	})
	if zoteroUpdateRes.IsError {
		t.Fatalf("expected successful update with zotero_items, got error: %s", zoteroUpdateRes.Content)
	}
}

func TestZoteroNamedRangeEncoding(t *testing.T) {
	fieldKey := "aBcDeF"
	code := buildZoteroCitationCode("cit12345", "(Setiawan, 2024)", "12345", "UXDB5SN6", "Penelitian Antares")
	if len(code) == 0 || code[:18] != "ITEM CSL_CITATION " {
		t.Fatalf("expected code to start with ITEM CSL_CITATION, got: %s", code)
	}

	chunks := encodeZoteroNamedRanges(fieldKey, code)
	if len(chunks) == 0 {
		t.Fatalf("expected at least 1 chunk, got 0")
	}

	for i, chunk := range chunks {
		expectedPrefix := "Z_F" + fieldKey + "000"
		if i == 0 && chunk[:len(expectedPrefix)] != expectedPrefix {
			t.Errorf("chunk 0 expected prefix %s, got: %s", expectedPrefix, chunk)
		}
		if len(chunk) > 255 {
			t.Errorf("chunk %d length %d exceeds 255 characters", i, len(chunk))
		}
	}

	// Verify UTF16 len calculation
	if utf16Len("Hello") != 5 {
		t.Errorf("expected 5, got %d", utf16Len("Hello"))
	}
	// Emoji takes 2 code units in UTF-16
	if utf16Len("😊") != 2 {
		t.Errorf("expected 2, got %d", utf16Len("😊"))
	}
}

func TestFindTextInDoc(t *testing.T) {
	content := []docContentItem{
		{
			StartIndex: 1,
			EndIndex:   19,
			Paragraph: &struct {
				ParagraphStyle *docParagraphStyle `json:"paragraphStyle"`
				Elements       []docContentElement `json:"elements"`
			}{
				Elements: []docContentElement{
					{
						StartIndex: 1,
						EndIndex:   19,
						TextRun: &struct {
							Content string `json:"content"`
						}{Content: "BAB 1 PENDAHULUAN\n"},
					},
				},
			},
		},
		{
			StartIndex: 19,
			EndIndex:   40,
			Paragraph: &struct {
				ParagraphStyle *docParagraphStyle `json:"paragraphStyle"`
				Elements       []docContentElement `json:"elements"`
			}{
				Elements: []docContentElement{
					{
						StartIndex: 19,
						EndIndex:   40,
						TextRun: &struct {
							Content string `json:"content"`
						}{Content: "BAB 2 KAJIAN PUSTAKA\n"},
					},
				},
			},
		},
		{
			StartIndex: 40,
			EndIndex:   52,
			Paragraph: &struct {
				ParagraphStyle *docParagraphStyle `json:"paragraphStyle"`
				Elements       []docContentElement `json:"elements"`
			}{
				Elements: []docContentElement{
					{
						StartIndex: 40,
						EndIndex:   52,
						TextRun: &struct {
							Content string `json:"content"`
						}{Content: "BAB 3 BILIK\n"},
					},
				},
			},
		},
		{
			StartIndex: 52,
			EndIndex:   79,
			Paragraph: &struct {
				ParagraphStyle *docParagraphStyle `json:"paragraphStyle"`
				Elements       []docContentElement `json:"elements"`
			}{
				Elements: []docContentElement{
					{
						StartIndex: 52,
						EndIndex:   79,
						TextRun: &struct {
							Content string `json:"content"`
						}{Content: "BAB 4 HASIL DAN PEMBAHASAN\n"},
					},
				},
			},
		},
	}

	m1 := findTextInDoc(content, "BAB 3 BILIK")
	if !m1.found {
		t.Fatalf("expected to find 'BAB 3 BILIK'")
	}
	if m1.matchStart != 40 || m1.matchEnd != 51 {
		t.Errorf("expected match range [40, 51), got [%d, %d)", m1.matchStart, m1.matchEnd)
	}
	if m1.paragraphStart != 40 || m1.paragraphEnd != 52 {
		t.Errorf("expected paragraph range [40, 52), got [%d, %d)", m1.paragraphStart, m1.paragraphEnd)
	}

	m2 := findTextInDoc(content, "bab 3")
	if !m2.found {
		t.Fatalf("expected case-insensitive match for 'bab 3'")
	}
	if m2.matchStart != 40 {
		t.Errorf("expected matchStart 40, got %d", m2.matchStart)
	}

	m3 := findTextInDoc(content, "BAB 15")
	if m3.found {
		t.Errorf("expected not found for 'BAB 15'")
	}
}
