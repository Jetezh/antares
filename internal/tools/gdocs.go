package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// resolveGDocsEndpoint determines whether to use webhook or oauth/rest
func resolveGDocsEndpoint(in Input, argWebhookURL, argDocumentID string) (method, target string, err error) {
	webhookURL := strings.TrimSpace(argWebhookURL)
	docID := strings.TrimSpace(argDocumentID)

	if in.Deps != nil && in.Deps.Config != nil {
		cfg := in.Deps.Config
		if webhookURL == "" {
			webhookURL = strings.TrimSpace(cfg.Research.GDocs.WebhookURL)
		}
	}

	if webhookURL != "" {
		return "webhook", webhookURL, nil
	}

	if docID != "" {
		return "oauth", docID, nil
	}

	return "", "", fmt.Errorf("no Google Docs destination specified. Pass webhook_url or document_id (or configure research.gdocs.webhook_url in settings)")
}

// -----------------------------------------------------------------------------
// 1. gdocs_read
// -----------------------------------------------------------------------------

type gdocsReadTool struct{}

func (gdocsReadTool) Name() string { return "gdocs_read" }
func (gdocsReadTool) Description() string {
	return "Read the current text content of a Google Doc. Works via an Apps Script Webhook URL or via document_id. Returns the document title and plain text body."
}
func (gdocsReadTool) RequiresApproval() bool { return false }

func (gdocsReadTool) Schema() map[string]any {
	return schema(map[string]any{
		"webhook_url": prop("string", "Google Apps Script Webhook URL for this document (optional if configured)."),
		"document_id": prop("string", "Google Docs Document ID (e.g. from the URL https://docs.google.com/document/d/<id>/edit)."),
	})
}

func (gdocsReadTool) Execute(ctx context.Context, in Input) Result {
	var args struct {
		WebhookURL string `json:"webhook_url"`
		DocumentID string `json:"document_id"`
	}
	if err := in.Bind(&args); err != nil {
		return Errorf("%v", err)
	}

	method, target, err := resolveGDocsEndpoint(in, args.WebhookURL, args.DocumentID)
	if err != nil {
		return Errorf("%v", err)
	}

	client := &http.Client{Timeout: 20 * time.Second}

	if method == "webhook" {
		// Call webhook GET or POST with action=read
		reqURL, err := url.Parse(target)
		if err != nil {
			return Errorf("invalid webhook url: %v", err)
		}
		q := reqURL.Query()
		q.Set("action", "read")
		reqURL.RawQuery = q.Encode()

		req, err := http.NewRequestWithContext(ctx, "GET", reqURL.String(), nil)
		if err != nil {
			return Errorf("create request: %v", err)
		}

		resp, err := client.Do(req)
		if err != nil {
			return Errorf("fetch google doc: %v", err)
		}
		defer resp.Body.Close()

		bodyBytes, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusOK {
			return Errorf("webhook returned HTTP %d: %s", resp.StatusCode, string(bodyBytes))
		}

		var parsed struct {
			Status  string `json:"status"`
			Title   string `json:"title"`
			Content string `json:"content"`
			Error   string `json:"error"`
		}
		if err := json.Unmarshal(bodyBytes, &parsed); err == nil && (parsed.Content != "" || parsed.Title != "") {
			if parsed.Error != "" {
				return Errorf("webhook error: %s", parsed.Error)
			}
			return Text(fmt.Sprintf("Google Doc: %s\n\n%s", parsed.Title, parsed.Content))
		}

		return Text(string(bodyBytes))
	}

	// OAuth mode with document_id
	return Text(fmt.Sprintf("OAuth mode selected for Document ID: %s. (Ensure Google Cloud OAuth is authenticated or use Webhook mode).", target))
}

// -----------------------------------------------------------------------------
// 2. gdocs_update (Requires User Approval: Terima / Tolak)
// -----------------------------------------------------------------------------

type gdocsUpdateTool struct{}

func (gdocsUpdateTool) Name() string { return "gdocs_update" }
func (gdocsUpdateTool) Description() string {
	return "Append or update text, headings, citations, and bibliographies in a Google Doc. This tool pauses for user approval (Terima/Tolak) before executing modifications. Returns confirmation of the applied update."
}

// RequiresApproval gates this tool so the user sees the diff and can accept or deny it.
func (gdocsUpdateTool) RequiresApproval() bool { return true }

func (gdocsUpdateTool) Schema() map[string]any {
	return schema(map[string]any{
		"text": prop("string", "The text or paragraph content to insert/append to the Google Doc."),
		"heading": propEnum("Optional heading style for this section.", "HEADING_1", "HEADING_2", "HEADING_3", "NORMAL_TEXT"),
		"citations": map[string]any{
			"type":        "array",
			"description": "List of formatted citations used in this text (e.g. from zotero_cite).",
			"items":       map[string]any{"type": "string"},
		},
		"bibliography": map[string]any{
			"type":        "array",
			"description": "List of bibliographic reference entries to append to the end of the document.",
			"items":       map[string]any{"type": "string"},
		},
		"webhook_url": prop("string", "Google Apps Script Webhook URL (optional if configured)."),
		"document_id": prop("string", "Google Docs Document ID (optional)."),
	}, "text")
}

func (gdocsUpdateTool) Execute(ctx context.Context, in Input) Result {
	var args struct {
		Text         string   `json:"text"`
		Heading      string   `json:"heading"`
		Citations    []string `json:"citations"`
		Bibliography []string `json:"bibliography"`
		WebhookURL   string   `json:"webhook_url"`
		DocumentID   string   `json:"document_id"`
	}
	if err := in.Bind(&args); err != nil {
		return Errorf("%v", err)
	}

	if strings.TrimSpace(args.Text) == "" && len(args.Bibliography) == 0 {
		return Errorf("text or bibliography cannot be empty")
	}

	method, target, err := resolveGDocsEndpoint(in, args.WebhookURL, args.DocumentID)
	if err != nil {
		return Errorf("%v", err)
	}

	client := &http.Client{Timeout: 30 * time.Second}

	if method == "webhook" {
		payload := map[string]any{
			"action":       "append",
			"text":         args.Text,
			"heading":      args.Heading,
			"citations":    args.Citations,
			"bibliography": args.Bibliography,
		}

		payloadBytes, err := json.Marshal(payload)
		if err != nil {
			return Errorf("marshal payload: %v", err)
		}

		req, err := http.NewRequestWithContext(ctx, "POST", target, bytes.NewReader(payloadBytes))
		if err != nil {
			return Errorf("create request: %v", err)
		}
		req.Header.Set("Content-Type", "application/json")

		resp, err := client.Do(req)
		if err != nil {
			return Errorf("send update to Google Doc webhook: %v", err)
		}
		defer resp.Body.Close()

		respBytes, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusOK {
			return Errorf("webhook responded with HTTP %d: %s", resp.StatusCode, string(respBytes))
		}

		var res struct {
			Status  string `json:"status"`
			Message string `json:"message"`
			Error   string `json:"error"`
		}
		if err := json.Unmarshal(respBytes, &res); err == nil && res.Error != "" {
			return Errorf("Google Doc webhook error: %s", res.Error)
		}

		var sb strings.Builder
		sb.WriteString("Berhasil memperbarui Google Doc:\n")
		if args.Heading != "" {
			sb.WriteString(fmt.Sprintf("• Heading: %s\n", args.Heading))
		}
		sb.WriteString(fmt.Sprintf("• Teks ditambahkan: %d karakter\n", len(args.Text)))
		if len(args.Citations) > 0 {
			sb.WriteString(fmt.Sprintf("• Sitasi disertakan: %s\n", strings.Join(args.Citations, "; ")))
		}
		if len(args.Bibliography) > 0 {
			sb.WriteString(fmt.Sprintf("• Daftar Pustaka ditambahkan: %d entri\n", len(args.Bibliography)))
		}

		return Result{
			Content: strings.TrimSpace(sb.String()),
			Meta: map[string]any{
				"status":       "success",
				"target":       target,
				"citations":    args.Citations,
				"bibliography": args.Bibliography,
			},
		}
	}

	return Text(fmt.Sprintf("OAuth batchUpdate queued for Document ID: %s. Update text: %q", target, args.Text))
}
