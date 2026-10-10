package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

func extractDocIDFromURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if idx := strings.Index(raw, "/document/d/"); idx != -1 {
		rest := raw[idx+len("/document/d/"):]
		if end := strings.Index(rest, "/"); end != -1 {
			return rest[:end]
		}
		if end := strings.Index(rest, "?"); end != -1 {
			return rest[:end]
		}
		return rest
	}
	return raw
}

// resolveGDocsEndpoint determines whether to use webhook or oauth/rest
func resolveGDocsEndpoint(in Input, argWebhookURL, argDocumentID string) (method, target string, err error) {
	webhookURL := strings.TrimSpace(argWebhookURL)
	docID := extractDocIDFromURL(argDocumentID)

	preferredMethod := "webhook"
	if in.Deps != nil && in.Deps.Config != nil {
		cfg := in.Deps.Config
		if cfg.Research.GDocs.Method != "" {
			preferredMethod = strings.ToLower(cfg.Research.GDocs.Method)
		}
		if webhookURL == "" {
			webhookURL = strings.TrimSpace(cfg.Research.GDocs.WebhookURL)
		}
		if docID == "" {
			if cfg.Research.GDocs.DocumentID != "" {
				docID = strings.TrimSpace(cfg.Research.GDocs.DocumentID)
			} else if cfg.Research.GDocs.DocumentURL != "" {
				docID = extractDocIDFromURL(cfg.Research.GDocs.DocumentURL)
			}
		}
	}

	if preferredMethod == "oauth" && docID != "" {
		return "oauth", docID, nil
	}
	if webhookURL != "" {
		return "webhook", webhookURL, nil
	}
	if docID != "" {
		return "oauth", docID, nil
	}

	return "", "", fmt.Errorf("no Google Docs destination specified. Pass webhook_url or document_id (or configure research.gdocs.webhook_url / document_url in settings)")
}

func getActiveGoogleToken(ctx context.Context, in Input) (string, error) {
	if in.Deps == nil || in.Deps.Store == nil || in.Deps.Config == nil {
		return "", fmt.Errorf("runtime dependencies not available")
	}
	cfg := in.Deps.Config
	clientID := strings.TrimSpace(cfg.Research.GDocs.OAuthClientID)
	clientSecret := strings.TrimSpace(cfg.Research.GDocs.OAuthClientSecret)
	if clientID == "" || clientSecret == "" {
		return "", fmt.Errorf("Google OAuth Client ID or Client Secret is missing. Please configure them in Research Settings")
	}

	refreshToken, _ := in.Deps.Store.GetKV(ctx, "research:gdocs:refresh_token")
	accessToken, _ := in.Deps.Store.GetKV(ctx, "research:gdocs:access_token")
	expiryStr, _ := in.Deps.Store.GetKV(ctx, "research:gdocs:token_expiry")
	var expiresAt int64
	if expiryStr != "" {
		expiresAt, _ = strconv.ParseInt(expiryStr, 10, 64)
	}

	// If access token is still valid (> 2 minutes remaining), reuse it
	if accessToken != "" && time.Now().Unix() < (expiresAt-120) {
		return accessToken, nil
	}

	if refreshToken == "" {
		if accessToken != "" {
			return accessToken, nil
		}
		return "", fmt.Errorf("Google account is not connected yet. Click 'Hubungkan Akun Google' in Research Settings")
	}

	// Refresh token via Google OAuth endpoint
	data := url.Values{}
	data.Set("client_id", clientID)
	data.Set("client_secret", clientSecret)
	data.Set("refresh_token", refreshToken)
	data.Set("grant_type", "refresh_token")

	req, err := http.NewRequestWithContext(ctx, "POST", "https://oauth2.googleapis.com/token", strings.NewReader(data.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("Google token refresh request failed: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("Google token refresh error (%d): %s", resp.StatusCode, string(bodyBytes))
	}

	var res struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(bodyBytes, &res); err != nil {
		return "", err
	}
	if res.AccessToken == "" {
		return "", fmt.Errorf("empty access token returned on refresh")
	}

	// Cache new access token
	_ = in.Deps.Store.SetKV(ctx, "research:gdocs:access_token", res.AccessToken)
	newExpiry := time.Now().Add(time.Duration(res.ExpiresIn) * time.Second).Unix()
	_ = in.Deps.Store.SetKV(ctx, "research:gdocs:token_expiry", strconv.FormatInt(newExpiry, 10))

	return res.AccessToken, nil
}

// -----------------------------------------------------------------------------
// 1. gdocs_read
// -----------------------------------------------------------------------------

type gdocsReadTool struct{}

func (gdocsReadTool) Name() string { return "gdocs_read" }
func (gdocsReadTool) Description() string {
	return "Read the current text content of a Google Doc. Always use this instead of the browser tool for Google Docs. Works via an Apps Script Webhook URL or via document_id. Returns the document title and plain text body."
}
func (gdocsReadTool) RequiresApproval() bool { return false }

func (gdocsReadTool) Schema() map[string]any {
	return schema(map[string]any{
		"webhook_url": prop("string", "Google Apps Script Webhook URL for this document (optional if configured)."),
		"document_id": prop("string", "Google Docs Document ID or full URL (optional if configured)."),
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

	// OAuth mode with document_id: call Google Docs REST API
	token, err := getActiveGoogleToken(ctx, in)
	if err != nil {
		return Errorf("%v", err)
	}

	reqURL := fmt.Sprintf("https://docs.googleapis.com/v1/documents/%s", url.PathEscape(target))
	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return Errorf("create request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := client.Do(req)
	if err != nil {
		return Errorf("fetch google doc via REST API: %v", err)
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return Errorf("Google Docs API returned HTTP %d: %s", resp.StatusCode, string(bodyBytes))
	}

	var doc struct {
		Title string `json:"title"`
		Body  struct {
			Content []struct {
				Paragraph *struct {
					Elements []struct {
						TextRun *struct {
							Content string `json:"content"`
						} `json:"textRun"`
					} `json:"elements"`
				} `json:"paragraph"`
			} `json:"content"`
		} `json:"body"`
	}

	if err := json.Unmarshal(bodyBytes, &doc); err != nil {
		return Errorf("parse document structure: %v", err)
	}

	var sb strings.Builder
	for _, c := range doc.Body.Content {
		if c.Paragraph != nil {
			for _, elem := range c.Paragraph.Elements {
				if elem.TextRun != nil {
					sb.WriteString(elem.TextRun.Content)
				}
			}
		}
	}

	return Text(fmt.Sprintf("Google Doc: %s (ID: %s)\n\n%s", doc.Title, target, strings.TrimSpace(sb.String())))
}

// -----------------------------------------------------------------------------
// 2. gdocs_update (Requires User Approval: Terima / Tolak)
// -----------------------------------------------------------------------------

type gdocsUpdateTool struct{}

func (gdocsUpdateTool) Name() string { return "gdocs_update" }
func (gdocsUpdateTool) Description() string {
	return "Append or update text, headings, citations, and bibliographies in a Google Doc. Always use this instead of the browser tool to write or edit Google Docs. This tool automatically triggers an approval prompt (Terima/Tolak) for the user before making changes. Returns confirmation of the applied update."
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
		"document_id": prop("string", "Google Docs Document ID or full URL (optional if configured)."),
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

	// OAuth mode with document_id: call Google Docs REST API batchUpdate
	token, err := getActiveGoogleToken(ctx, in)
	if err != nil {
		return Errorf("%v", err)
	}

	var requests []map[string]any

	contentToInsert := args.Text
	if args.Heading != "" {
		contentToInsert = args.Heading + "\n" + contentToInsert
	}
	if len(args.Citations) > 0 {
		contentToInsert += " (" + strings.Join(args.Citations, "; ") + ")"
	}
	if len(args.Bibliography) > 0 {
		contentToInsert += "\n\nDaftar Pustaka:\n"
		for i, bib := range args.Bibliography {
			contentToInsert += fmt.Sprintf("[%d] %s\n", i+1, bib)
		}
	}

	requests = append(requests, map[string]any{
		"insertText": map[string]any{
			"endOfSegmentLocation": map[string]any{},
			"text":                 "\n" + contentToInsert + "\n",
		},
	})

	batchReq := map[string]any{
		"requests": requests,
	}

	batchBytes, err := json.Marshal(batchReq)
	if err != nil {
		return Errorf("marshal batchUpdate request: %v", err)
	}

	reqURL := fmt.Sprintf("https://docs.googleapis.com/v1/documents/%s:batchUpdate", url.PathEscape(target))
	req, err := http.NewRequestWithContext(ctx, "POST", reqURL, bytes.NewReader(batchBytes))
	if err != nil {
		return Errorf("create request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return Errorf("send batchUpdate to Google Docs: %v", err)
	}
	defer resp.Body.Close()

	respBytes, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return Errorf("Google Docs API returned HTTP %d: %s", resp.StatusCode, string(respBytes))
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Berhasil memperbarui Google Doc (ID: %s via Google Docs API):\n", target))
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
