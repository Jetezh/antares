package tools

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
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
		if err := ValidateGDocsDocID(docID); err != nil {
			return "", "", err
		}
		return "oauth", docID, nil
	}
	if webhookURL != "" {
		if err := ValidateGDocsWebhookURL(webhookURL); err != nil {
			return "", "", err
		}
		return "webhook", webhookURL, nil
	}
	if docID != "" {
		if err := ValidateGDocsDocID(docID); err != nil {
			return "", "", err
		}
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

type ZoteroCitationItem struct {
	Key      string `json:"key"`
	Citation string `json:"citation"`
	Title    string `json:"title,omitempty"`
}

func randomAlphanumeric(n int) string {
	const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	b := make([]byte, n)
	max := big.NewInt(int64(len(charset)))
	for i := range b {
		val, err := rand.Int(rand.Reader, max)
		if err != nil {
			b[i] = charset[i%len(charset)]
		} else {
			b[i] = charset[val.Int64()]
		}
	}
	return string(b)
}

func utf16Len(s string) int {
	return len(utf16.Encode([]rune(s)))
}

func resolveZoteroUserID(in Input) string {
	if in.Deps != nil && in.Deps.Config != nil {
		id := strings.TrimSpace(in.Deps.Config.Research.Zotero.UserID)
		if id != "" {
			return id
		}
	}
	return "0"
}

// encodeZoteroNamedRanges splits the CSL citation payload into chunked Named Ranges
// adhering to the Zotero Google Docs Connector protocol (max 255 chars per range name).
func encodeZoteroNamedRanges(fieldKey, code string) []string {
	prefix := "Z_F" + fieldKey
	var chunks []string
	i := 0
	maxChunkLen := 255 - len(prefix) - 3 // 255 - 9 - 3 = 243
	remaining := code
	for len(remaining) > 0 {
		idxStr := fmt.Sprintf("%03d", i)
		take := maxChunkLen
		if len(remaining) < take {
			take = len(remaining)
		}
		chunk := prefix + idxStr + remaining[:take]
		chunks = append(chunks, chunk)
		remaining = remaining[take:]
		i++
	}
	return chunks
}

type cslCitationItem struct {
	ID       string         `json:"id"`
	URIs     []string       `json:"uris"`
	ItemData map[string]any `json:"itemData,omitempty"`
}

type cslCitationPayload struct {
	CitationID string `json:"citationID"`
	Properties struct {
		FormattedCitation string `json:"formattedCitation"`
		PlainCitation     string `json:"plainCitation"`
		NoteIndex         int    `json:"noteIndex"`
	} `json:"properties"`
	CitationItems []cslCitationItem `json:"citationItems"`
	Schema        string            `json:"schema"`
}

func buildZoteroCitationCode(citationID, formattedCitation, userID, itemKey, title string) string {
	var payload cslCitationPayload
	payload.CitationID = citationID
	payload.Properties.FormattedCitation = formattedCitation
	payload.Properties.PlainCitation = formattedCitation
	payload.Properties.NoteIndex = 0
	payload.Schema = "https://github.com/citation-style-language/schema/raw/master/csl-citation.json"

	uri := fmt.Sprintf("http://zotero.org/users/%s/items/%s", userID, itemKey)
	itemData := map[string]any{
		"id": itemKey,
	}
	if title != "" {
		itemData["title"] = title
	}
	payload.CitationItems = []cslCitationItem{
		{
			ID:       itemKey,
			URIs:     []string{uri},
			ItemData: itemData,
		},
	}
	jsonBytes, _ := json.Marshal(payload)
	return "ITEM CSL_CITATION " + string(jsonBytes)
}

type gdocsUpdateTool struct{}

func (gdocsUpdateTool) Name() string { return "gdocs_update" }
func (gdocsUpdateTool) Description() string {
	return "Append or update text, headings, citations, and bibliographies in a Google Doc. Always use this instead of the browser tool to write or edit Google Docs. Citations can be passed via zotero_items or item_keys to embed official Zotero Named Ranges recognized by the Zotero Google Docs extension. Triggers an approval prompt (Terima/Tolak) for the user before making changes."
}

// RequiresApproval gates this tool so the user sees the diff and can accept or deny it.
func (gdocsUpdateTool) RequiresApproval() bool { return true }

func (gdocsUpdateTool) Schema() map[string]any {
	return schema(map[string]any{
		"text":         prop("string", "The text or paragraph content to insert/append to the Google Doc. You can include inline [cite:ITEMKEY] tags to place citations at specific locations within the text."),
		"find_text":    prop("string", "Anchor text or heading to target a specific position in the document (e.g. 'BAB 3 BILIK' or '3.1 Latar Belakang'). If omitted, appends to the end of the document."),
		"position":     propEnum("Target position relative to find_text: 'after' (insert right after the matching section), 'before' (insert right before), 'replace' (replace the matching text or section). Default: 'after' when find_text is provided.", "after", "before", "replace"),
		"end_text":     prop("string", "Optional end anchor when position is 'replace'. Replaces the entire section between find_text and end_text (e.g. find_text: 'BAB 3 BILIK', end_text: 'BAB 4')."),
		"heading":      propEnum("Optional heading style for this section.", "HEADING_1", "HEADING_2", "HEADING_3", "NORMAL_TEXT"),
		"font":         propDefault("string", "Font family for inserted text (e.g. 'Times New Roman', 'Arial'). Default: 'Times New Roman'.", "Times New Roman"),
		"align":        propEnum("Paragraph alignment: JUSTIFIED, START, CENTER, END. Default: JUSTIFIED.", "JUSTIFIED", "START", "CENTER", "END"),
		"citations": map[string]any{
			"type":        "array",
			"description": "List of formatted citations used in this text (e.g. from zotero_cite).",
			"items":       map[string]any{"type": "string"},
		},
		"zotero_items": map[string]any{
			"type":        "array",
			"description": "List of Zotero citation items to embed as official Zotero Google Docs fields (Named Ranges). Each item has 'key' (Zotero item key) and 'citation' (in-text citation, e.g. '(Smith, 2020)').",
			"items": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"key":      map[string]any{"type": "string", "description": "Zotero item key (e.g. UXDB5SN6)"},
					"citation": map[string]any{"type": "string", "description": "Formatted in-text citation string (e.g. (Smith, 2020))"},
					"title":    map[string]any{"type": "string", "description": "Optional title of the cited paper"},
				},
				"required": []string{"key", "citation"},
			},
		},
		"item_keys": map[string]any{
			"type":        "array",
			"description": "Optional Zotero item keys matching the citations array to automatically generate official Zotero Named Range fields.",
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

type docContentElement struct {
	StartIndex int `json:"startIndex"`
	EndIndex   int `json:"endIndex"`
	TextRun    *struct {
		Content string `json:"content"`
	} `json:"textRun"`
}

type docContentItem struct {
	StartIndex int `json:"startIndex"`
	EndIndex   int `json:"endIndex"`
	Paragraph  *struct {
		Elements []docContentElement `json:"elements"`
	} `json:"paragraph"`
}

type textMatchRange struct {
	found          bool
	matchStart     int
	matchEnd       int
	paragraphStart int
	paragraphEnd   int
}

func findTextInDoc(contents []docContentItem, query string) textMatchRange {
	query = strings.TrimSpace(query)
	if query == "" {
		return textMatchRange{}
	}
	queryLower := strings.ToLower(query)

	// Search paragraph-by-paragraph first
	for _, c := range contents {
		if c.Paragraph == nil {
			continue
		}
		var paraText strings.Builder
		var indexMap []int

		for _, elem := range c.Paragraph.Elements {
			if elem.TextRun == nil {
				continue
			}
			runStr := elem.TextRun.Content
			runStart := elem.StartIndex
			offset := 0
			for _, r := range runStr {
				rUnits := utf16Len(string(r))
				paraText.WriteRune(r)
				for u := 0; u < rUnits; u++ {
					indexMap = append(indexMap, runStart+offset+u)
				}
				offset += rUnits
			}
		}

		fullStr := paraText.String()
		pos := strings.Index(strings.ToLower(fullStr), queryLower)
		if pos != -1 && pos < len(indexMap) {
			mStart := indexMap[pos]
			endPos := pos + utf16Len(query)
			mEnd := mStart + utf16Len(query)
			if endPos <= len(indexMap) {
				mEnd = indexMap[endPos-1] + 1
			}
			return textMatchRange{
				found:          true,
				matchStart:     mStart,
				matchEnd:       mEnd,
				paragraphStart: c.StartIndex,
				paragraphEnd:   c.EndIndex,
			}
		}
	}

	// Document-wide fallback search across paragraph boundaries
	var docText strings.Builder
	var docIndexMap []int
	type pBoundary struct {
		start int
		end   int
	}
	var charToPara []pBoundary

	for _, c := range contents {
		if c.Paragraph == nil {
			continue
		}
		pBound := pBoundary{start: c.StartIndex, end: c.EndIndex}
		for _, elem := range c.Paragraph.Elements {
			if elem.TextRun == nil {
				continue
			}
			runStr := elem.TextRun.Content
			runStart := elem.StartIndex
			offset := 0
			for _, r := range runStr {
				rUnits := utf16Len(string(r))
				docText.WriteRune(r)
				for u := 0; u < rUnits; u++ {
					docIndexMap = append(docIndexMap, runStart+offset+u)
					charToPara = append(charToPara, pBound)
				}
				offset += rUnits
			}
		}
	}

	fullDocStr := docText.String()
	pos := strings.Index(strings.ToLower(fullDocStr), queryLower)
	if pos != -1 && pos < len(docIndexMap) {
		mStart := docIndexMap[pos]
		endPos := pos + utf16Len(query)
		mEnd := mStart + utf16Len(query)
		if endPos <= len(docIndexMap) {
			mEnd = docIndexMap[endPos-1] + 1
		}
		pBound := charToPara[pos]
		return textMatchRange{
			found:          true,
			matchStart:     mStart,
			matchEnd:       mEnd,
			paragraphStart: pBound.start,
			paragraphEnd:   pBound.end,
		}
	}

	return textMatchRange{}
}

func (gdocsUpdateTool) Execute(ctx context.Context, in Input) Result {
	var args struct {
		Text            string               `json:"text"`
		FindText        string               `json:"find_text"`
		Position        string               `json:"position"`
		EndText         string               `json:"end_text"`
		Heading         string               `json:"heading"`
		Font            string               `json:"font"`
		Align           string               `json:"align"`
		Citations       []string             `json:"citations"`
		ZoteroItems     []ZoteroCitationItem `json:"zotero_items"`
		ItemKeys        []string             `json:"item_keys"`
		Bibliography    []string             `json:"bibliography"`
		WebhookURL      string               `json:"webhook_url"`
		DocumentID      string               `json:"document_id"`
	}
	if err := in.Bind(&args); err != nil {
		return Errorf("%v", err)
	}

	if strings.TrimSpace(args.Text) == "" && len(args.Bibliography) == 0 {
		return Errorf("text or bibliography cannot be empty")
	}

	fontFamily := strings.TrimSpace(args.Font)
	if fontFamily == "" {
		fontFamily = "Times New Roman"
	}
	alignment := strings.TrimSpace(strings.ToUpper(args.Align))
	if alignment == "" {
		alignment = "JUSTIFIED"
	}

	// Consolidate Zotero citation items
	zoteroItems := args.ZoteroItems
	if len(zoteroItems) == 0 && len(args.ItemKeys) > 0 {
		for i, k := range args.ItemKeys {
			citeStr := "[cite:" + k + "]"
			if i < len(args.Citations) {
				citeStr = args.Citations[i]
			}
			zoteroItems = append(zoteroItems, ZoteroCitationItem{
				Key:      k,
				Citation: citeStr,
			})
		}
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
			"zotero_items": zoteroItems,
			"item_keys":    args.ItemKeys,
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
		if len(zoteroItems) > 0 {
			sb.WriteString(fmt.Sprintf("• Item Zotero: %d item\n", len(zoteroItems)))
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
				"zotero_items": zoteroItems,
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
	var citeCount int

	// Fetch document structure to locate exact indices
	docReq, err := http.NewRequestWithContext(ctx, "GET", fmt.Sprintf("https://docs.googleapis.com/v1/documents/%s", url.PathEscape(target)), nil)
	if err != nil {
		return Errorf("create request: %v", err)
	}
	docReq.Header.Set("Authorization", "Bearer "+token)

	docResp, err := client.Do(docReq)
	if err != nil {
		return Errorf("fetch google doc structure: %v", err)
	}
	defer docResp.Body.Close()

	var docInfo struct {
		Body struct {
			Content []docContentItem `json:"content"`
		} `json:"body"`
	}
	if err := json.NewDecoder(docResp.Body).Decode(&docInfo); err != nil {
		return Errorf("decode google doc structure: %v", err)
	}

	insertIndex := 1
	type indexRange struct {
		start int
		end   int
	}
	var deleteRange *indexRange

	findText := strings.TrimSpace(args.FindText)
	posMode := strings.TrimSpace(strings.ToLower(args.Position))
	if posMode == "" {
		if findText != "" {
			posMode = "after"
		} else {
			posMode = "append"
		}
	}

	if findText != "" {
		match := findTextInDoc(docInfo.Body.Content, findText)
		if !match.found {
			return Errorf("penanda find_text %q tidak ditemukan di Google Doc. Gunakan gdocs_read untuk memeriksa teks/judul yang persis ada di dokumen.", findText)
		}

		switch posMode {
		case "after":
			insertIndex = match.paragraphEnd
		case "before":
			insertIndex = match.paragraphStart
		case "replace":
			endText := strings.TrimSpace(args.EndText)
			if endText != "" {
				endMatch := findTextInDoc(docInfo.Body.Content, endText)
				if !endMatch.found {
					return Errorf("penanda end_text %q tidak ditemukan di Google Doc.", endText)
				}
				// Replace between match.paragraphEnd (keeping find_text heading intact)
				// and endMatch.paragraphStart (keeping end_text heading intact)
				delStart := match.paragraphEnd
				delEnd := endMatch.paragraphStart
				if delStart > delEnd {
					delStart = match.matchEnd
					delEnd = endMatch.matchStart
				}
				if delStart >= delEnd {
					return Errorf("posisi end_text (%d) berada sebelum atau sama dengan find_text (%d).", delEnd, delStart)
				}
				deleteRange = &indexRange{start: delStart, end: delEnd}
				insertIndex = delStart
			} else {
				// Replace the match itself (e.g. placeholder tag)
				deleteRange = &indexRange{start: match.matchStart, end: match.matchEnd}
				insertIndex = match.matchStart
			}
		default:
			insertIndex = match.paragraphEnd
		}
	} else {
		if len(docInfo.Body.Content) > 0 {
			lastIdx := docInfo.Body.Content[len(docInfo.Body.Content)-1].EndIndex
			if lastIdx > 1 {
				insertIndex = lastIdx - 1
			}
		}
	}

	type citeRange struct {
		start    int
		end      int
		key      string
		citation string
		title    string
	}
	var citeRanges []citeRange

	var bibRanges []indexRange

	var textBuilder strings.Builder
	cursor := insertIndex

	textBuilder.WriteString("\n")
	cursor += 1
	contentStart := cursor

	headingStart := 0
	headingEnd := 0
	if args.Heading != "" {
		headingStart = cursor
		textBuilder.WriteString(args.Heading + "\n")
		cursor += utf16Len(args.Heading) + 1
		headingEnd = cursor - 1
	}

	bodyStart := cursor
	bodyText := args.Text
	hasInlinePlaceholders := false
	for _, item := range zoteroItems {
		tag := "[cite:" + item.Key + "]"
		if strings.Contains(bodyText, tag) {
			hasInlinePlaceholders = true
			break
		}
	}

	if hasInlinePlaceholders {
		var newBody strings.Builder
		remaining := bodyText
		for {
			earliestTag := ""
			earliestPos := -1
			var matchingItem ZoteroCitationItem
			for _, item := range zoteroItems {
				tag := "[cite:" + item.Key + "]"
				pos := strings.Index(remaining, tag)
				if pos != -1 && (earliestPos == -1 || pos < earliestPos) {
					earliestPos = pos
					earliestTag = tag
					matchingItem = item
				}
			}
			if earliestPos == -1 {
				newBody.WriteString(remaining)
				cursor += utf16Len(remaining)
				break
			}
			before := remaining[:earliestPos]
			newBody.WriteString(before)
			cursor += utf16Len(before)

			cStart := cursor
			newBody.WriteString(matchingItem.Citation)
			cursor += utf16Len(matchingItem.Citation)
			cEnd := cursor

			citeRanges = append(citeRanges, citeRange{
				start:    cStart,
				end:      cEnd,
				key:      matchingItem.Key,
				citation: matchingItem.Citation,
				title:    matchingItem.Title,
			})

			remaining = remaining[earliestPos+len(earliestTag):]
		}
		textBuilder.WriteString(newBody.String())
	} else {
		textBuilder.WriteString(bodyText)
		cursor += utf16Len(bodyText)

		if len(zoteroItems) > 0 {
			textBuilder.WriteString(" (")
			cursor += 2
			for i, item := range zoteroItems {
				if i > 0 {
					textBuilder.WriteString("; ")
					cursor += 2
				}
				cStart := cursor
				textBuilder.WriteString(item.Citation)
				cursor += utf16Len(item.Citation)
				cEnd := cursor

				citeRanges = append(citeRanges, citeRange{
					start:    cStart,
					end:      cEnd,
					key:      item.Key,
					citation: item.Citation,
					title:    item.Title,
				})
			}
			textBuilder.WriteString(")")
			cursor += 1
		} else if len(args.Citations) > 0 {
			cites := " (" + strings.Join(args.Citations, "; ") + ")"
			textBuilder.WriteString(cites)
			cursor += utf16Len(cites)
		}
	}
	bodyEnd := cursor

	bibHeadingStart := 0
	bibHeadingEnd := 0
	if len(args.Bibliography) > 0 {
		textBuilder.WriteString("\n\nDaftar Pustaka:\n")
		cursor += 2
		bibHeadingStart = cursor
		cursor += utf16Len("Daftar Pustaka:") + 1
		bibHeadingEnd = cursor - 1

		for i, bib := range args.Bibliography {
			entry := fmt.Sprintf("[%d] %s\n", i+1, bib)
			bStart := cursor
			textBuilder.WriteString(entry)
			cursor += utf16Len(entry)
			bEnd := cursor - 1
			bibRanges = append(bibRanges, indexRange{start: bStart, end: bEnd})
		}
	}

	textBuilder.WriteString("\n")
	contentEnd := cursor - 1

	// 0. Optional Delete Range (for position="replace")
	if deleteRange != nil && deleteRange.start < deleteRange.end {
		requests = append(requests, map[string]any{
			"deleteContentRange": map[string]any{
				"range": map[string]any{
					"startIndex": deleteRange.start,
					"endIndex":   deleteRange.end,
				},
			},
		})
	}

	// 1. Insert Text
	requests = append(requests, map[string]any{
		"insertText": map[string]any{
			"location": map[string]any{
				"index": insertIndex,
			},
			"text": textBuilder.String(),
		},
	})

	// 2. Format Academic Typography (Times New Roman, 12pt)
	if contentStart < contentEnd {
		requests = append(requests, map[string]any{
			"updateTextStyle": map[string]any{
				"range": map[string]any{
					"startIndex": contentStart,
					"endIndex":   contentEnd,
				},
				"textStyle": map[string]any{
					"weightedFontFamily": map[string]any{
						"fontFamily": fontFamily,
					},
					"fontSize": map[string]any{
						"magnitude": 12,
						"unit":      "PT",
					},
				},
				"fields": "weightedFontFamily,fontSize",
			},
		})
	}

	// 3. Format Paragraph Alignment (Justified, 1.15 lineSpacing)
	if bodyStart < bodyEnd {
		requests = append(requests, map[string]any{
			"updateParagraphStyle": map[string]any{
				"range": map[string]any{
					"startIndex": bodyStart,
					"endIndex":   bodyEnd,
				},
				"paragraphStyle": map[string]any{
					"alignment":   alignment,
					"lineSpacing": 115,
					"spaceBelow": map[string]any{
						"magnitude": 6,
						"unit":      "PT",
					},
				},
				"fields": "alignment,lineSpacing,spaceBelow",
			},
		})
	}

	// 4. Format Section Heading
	if args.Heading != "" && headingStart < headingEnd {
		requests = append(requests, map[string]any{
			"updateParagraphStyle": map[string]any{
				"range": map[string]any{
					"startIndex": headingStart,
					"endIndex":   headingEnd,
				},
				"paragraphStyle": map[string]any{
					"namedStyleType": args.Heading,
				},
				"fields": "namedStyleType",
			},
		})
	}

	// 5. Format Bibliography Heading and Hanging Indent
	if bibHeadingStart < bibHeadingEnd {
		requests = append(requests, map[string]any{
			"updateParagraphStyle": map[string]any{
				"range": map[string]any{
					"startIndex": bibHeadingStart,
					"endIndex":   bibHeadingEnd,
				},
				"paragraphStyle": map[string]any{
					"namedStyleType": "HEADING_2",
				},
				"fields": "namedStyleType",
			},
		})
	}

	for _, br := range bibRanges {
		if br.start < br.end {
			requests = append(requests, map[string]any{
				"updateParagraphStyle": map[string]any{
					"range": map[string]any{
						"startIndex": br.start,
						"endIndex":   br.end,
					},
					"paragraphStyle": map[string]any{
						"alignment": alignment,
						"indentStart": map[string]any{
							"magnitude": 36,
							"unit":      "PT",
						},
						"indentFirstLine": map[string]any{
							"magnitude": -36,
							"unit":      "PT",
						},
						"spaceBelow": map[string]any{
							"magnitude": 6,
							"unit":      "PT",
						},
					},
					"fields": "alignment,indentStart,indentFirstLine,spaceBelow",
				},
			})
		}
	}

	// 6. Format Zotero Named Ranges & Links
	userID := resolveZoteroUserID(in)
	for _, cr := range citeRanges {
		fieldKey := randomAlphanumeric(6)
		linkURL := "https://www.zotero.org/google-docs/?" + fieldKey

		requests = append(requests, map[string]any{
			"updateTextStyle": map[string]any{
				"range": map[string]any{
					"startIndex": cr.start,
					"endIndex":   cr.end,
				},
				"textStyle": map[string]any{
					"link": map[string]any{
						"url": linkURL,
					},
				},
				"fields": "link",
			},
		})

		citationID := randomAlphanumeric(8)
		code := buildZoteroCitationCode(citationID, cr.citation, userID, cr.key, cr.title)
		chunks := encodeZoteroNamedRanges(fieldKey, code)
		for _, chunk := range chunks {
			requests = append(requests, map[string]any{
				"createNamedRange": map[string]any{
					"name": chunk,
					"range": map[string]any{
						"startIndex": cr.start,
						"endIndex":   cr.end,
					},
				},
			})
		}
	}

	citeCount = len(citeRanges)

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
	if findText != "" {
		sb.WriteString(fmt.Sprintf("• Posisi target: %s penanda %q (indeks %d)\n", posMode, findText, insertIndex))
		if deleteRange != nil {
			sb.WriteString(fmt.Sprintf("• Rentang teks lama digantikan: indeks %d s/d %d\n", deleteRange.start, deleteRange.end))
		}
	}
	if args.Heading != "" {
		sb.WriteString(fmt.Sprintf("• Heading: %s\n", args.Heading))
	}
	sb.WriteString(fmt.Sprintf("• Teks ditambahkan: %d karakter\n", len(args.Text)))
	if len(args.Citations) > 0 {
		sb.WriteString(fmt.Sprintf("• Sitasi disertakan: %s\n", strings.Join(args.Citations, "; ")))
	}
	if citeCount > 0 {
		sb.WriteString(fmt.Sprintf("• Sitasi Zotero resmi disematkan: %d sitasi (Named Ranges terhubung ke Zotero Extension)\n", citeCount))
	}
	if len(args.Bibliography) > 0 {
		sb.WriteString(fmt.Sprintf("• Daftar Pustaka ditambahkan: %d entri\n", len(args.Bibliography)))
	}

	return Result{
		Content: strings.TrimSpace(sb.String()),
		Meta: map[string]any{
			"status":          "success",
			"target":          target,
			"find_text":       findText,
			"position":        posMode,
			"insert_index":    insertIndex,
			"citations":       args.Citations,
			"zotero_items":    zoteroItems,
			"zotero_embedded": citeCount,
			"bibliography":    args.Bibliography,
		},
	}
}
