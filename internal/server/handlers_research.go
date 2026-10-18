package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/enowdev/antares/internal/config"
	"github.com/enowdev/antares/internal/tools"
)

func extractGoogleDocID(raw string) string {
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

func (s *Server) handleGetResearchSettings(w http.ResponseWriter, r *http.Request) {
	cfg := s.config()
	apiKey := cfg.Research.Zotero.APIKey
	if apiKey != "" {
		apiKey = config.MaskSecret(apiKey)
	}
	oauthSecret := cfg.Research.GDocs.OAuthClientSecret
	if oauthSecret != "" {
		oauthSecret = config.MaskSecret(oauthSecret)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"zotero": map[string]any{
			"user_id": cfg.Research.Zotero.UserID,
			"api_key": apiKey,
		},
		"gdocs": map[string]any{
			"method":              cfg.Research.GDocs.Method,
			"webhook_url":         cfg.Research.GDocs.WebhookURL,
			"document_url":        cfg.Research.GDocs.DocumentURL,
			"document_id":         cfg.Research.GDocs.DocumentID,
			"oauth_client_id":     cfg.Research.GDocs.OAuthClientID,
			"oauth_client_secret": oauthSecret,
		},
	})
}

func (s *Server) handleSaveResearchSettings(w http.ResponseWriter, r *http.Request) {
	if s.requireDashboardPassword(w, r) {
		return
	}
	var body struct {
		Zotero struct {
			UserID *string `json:"user_id"`
			APIKey *string `json:"api_key"`
		} `json:"zotero"`
		GDocs struct {
			Method            *string `json:"method"`
			WebhookURL        *string `json:"webhook_url"`
			DocumentURL       *string `json:"document_url"`
			OAuthClientID     *string `json:"oauth_client_id"`
			OAuthClientSecret *string `json:"oauth_client_secret"`
		} `json:"gdocs"`
	}

	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	// Security validation on all incoming inputs
	if (body.Zotero.UserID != nil && *body.Zotero.UserID != "") || (body.Zotero.APIKey != nil && *body.Zotero.APIKey != "") {
		uID := ""
		if body.Zotero.UserID != nil {
			uID = *body.Zotero.UserID
		}
		aKey := ""
		if body.Zotero.APIKey != nil && !strings.Contains(*body.Zotero.APIKey, "••••") {
			aKey = *body.Zotero.APIKey
		}
		if err := tools.ValidateZoteroCreds(uID, aKey); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
	}
	if body.GDocs.WebhookURL != nil && *body.GDocs.WebhookURL != "" {
		if err := tools.ValidateGDocsWebhookURL(*body.GDocs.WebhookURL); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
	}
	if body.GDocs.DocumentURL != nil && *body.GDocs.DocumentURL != "" {
		docID := extractGoogleDocID(*body.GDocs.DocumentURL)
		if err := tools.ValidateGDocsDocID(docID); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
	}
	if (body.GDocs.OAuthClientID != nil && *body.GDocs.OAuthClientID != "") || (body.GDocs.OAuthClientSecret != nil && *body.GDocs.OAuthClientSecret != "") {
		cID := ""
		if body.GDocs.OAuthClientID != nil {
			cID = *body.GDocs.OAuthClientID
		}
		cSec := ""
		if body.GDocs.OAuthClientSecret != nil && !strings.Contains(*body.GDocs.OAuthClientSecret, "••••") {
			cSec = *body.GDocs.OAuthClientSecret
		}
		if err := tools.ValidateGoogleOAuthCreds(cID, cSec); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
	}

	cfg, err := config.Reload()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	if body.Zotero.UserID != nil {
		cfg.Research.Zotero.UserID = *body.Zotero.UserID
	}
	if body.Zotero.APIKey != nil && !strings.Contains(*body.Zotero.APIKey, "••••") {
		cfg.Research.Zotero.APIKey = *body.Zotero.APIKey
	}
	if body.GDocs.Method != nil {
		cfg.Research.GDocs.Method = *body.GDocs.Method
	}
	if body.GDocs.WebhookURL != nil {
		cfg.Research.GDocs.WebhookURL = *body.GDocs.WebhookURL
	}
	if body.GDocs.DocumentURL != nil {
		cfg.Research.GDocs.DocumentURL = *body.GDocs.DocumentURL
		if *body.GDocs.DocumentURL != "" {
			cfg.Research.GDocs.DocumentID = extractGoogleDocID(*body.GDocs.DocumentURL)
		} else {
			cfg.Research.GDocs.DocumentID = ""
			_ = s.db.SetKV(r.Context(), "research:gdocs:last_exported_url", "")
		}
	}
	if body.GDocs.OAuthClientID != nil {
		cfg.Research.GDocs.OAuthClientID = *body.GDocs.OAuthClientID
	}
	if body.GDocs.OAuthClientSecret != nil && !strings.Contains(*body.GDocs.OAuthClientSecret, "••••") {
		cfg.Research.GDocs.OAuthClientSecret = *body.GDocs.OAuthClientSecret
	}

	if err := config.Save(cfg); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	_ = s.applyReload()

	writeJSON(w, http.StatusOK, map[string]any{"status": "saved"})
}

func (s *Server) handleGDocsRollback(w http.ResponseWriter, r *http.Request) {
	if s.requireDashboardPassword(w, r) {
		return
	}
	ctx := r.Context()
	var body struct {
		DocumentID string `json:"document_id"`
	}
	_ = decodeBody(r, &body)

	targetID := strings.TrimSpace(body.DocumentID)
	if targetID == "" {
		cfg := s.config()
		targetID = strings.TrimSpace(cfg.Research.GDocs.DocumentID)
		if targetID == "" && cfg.Research.GDocs.DocumentURL != "" {
			targetID = extractGoogleDocID(cfg.Research.GDocs.DocumentURL)
		}
	}
	if targetID == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("document_id is required for rollback"))
		return
	}

	tool, ok := tools.Default().Get("gdocs_rollback")
	if !ok {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("gdocs_rollback tool is not registered"))
		return
	}

	argsJSON, _ := json.Marshal(map[string]any{"document_id": targetID})
	res := tool.Execute(ctx, tools.Input{
		Args: argsJSON,
		Deps: &tools.Deps{
			Config: s.config(),
			Store:  s.db,
		},
	})

	if res.IsError {
		writeError(w, http.StatusBadRequest, fmt.Errorf("%s", res.Content))
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "success",
		"message": res.Content,
		"meta":    res.Meta,
	})
}

func (s *Server) handleGDocsExport(w http.ResponseWriter, r *http.Request) {
	if s.requireDashboardPassword(w, r) {
		return
	}
	ctx := r.Context()
	var body struct {
		Title      string `json:"title"`
		HTML       string `json:"html"`
		AutoShare  *bool  `json:"auto_share"`  // default true: anyone with link can edit
		ShareRole  string `json:"share_role"`  // writer (edit) or reader (view)
	}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	title := strings.TrimSpace(body.Title)
	if title == "" {
		title = "Dokumen Antares - " + time.Now().Format("2006-01-02 15:04")
	}
	contentHTML := strings.TrimSpace(body.HTML)
	if contentHTML == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("html content cannot be empty"))
		return
	}

	token, err := tools.ResolveActiveGoogleToken(ctx, s.config(), s.db)
	if err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("Google account is not connected: %w", err))
		return
	}

	// Prepare multipart/related upload body to Google Drive API
	// Metadata sets target Google Docs mimeType: application/vnd.google-apps.document
	// Media part contains the semantic HTML
	boundary := fmt.Sprintf("-------AntaresBoundary%d", time.Now().UnixNano())
	var b bytes.Buffer

	// Part 1: Metadata JSON
	b.WriteString(fmt.Sprintf("--%s\r\n", boundary))
	b.WriteString("Content-Type: application/json; charset=UTF-8\r\n\r\n")
	meta := map[string]string{
		"name":     title,
		"mimeType": "application/vnd.google-apps.document",
	}
	metaBytes, _ := json.Marshal(meta)
	b.Write(metaBytes)
	b.WriteString("\r\n")

	// Part 2: HTML Content
	b.WriteString(fmt.Sprintf("--%s\r\n", boundary))
	b.WriteString("Content-Type: text/html; charset=UTF-8\r\n\r\n")
	b.WriteString(contentHTML)
	b.WriteString(fmt.Sprintf("\r\n--%s--\r\n", boundary))

	uploadURL := "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart"
	req, err := http.NewRequestWithContext(ctx, "POST", uploadURL, &b)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("create drive upload request: %w", err))
		return
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", fmt.Sprintf("multipart/related; boundary=%s", boundary))

	client := &http.Client{Timeout: 45 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("send request to Google Drive: %w", err))
		return
	}
	defer resp.Body.Close()

	respBytes, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		writeError(w, http.StatusBadRequest, fmt.Errorf("Google Drive API error (%d): %s", resp.StatusCode, string(respBytes)))
		return
	}

	var driveResp struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		MimeType string `json:"mimeType"`
	}
	if err := json.Unmarshal(respBytes, &driveResp); err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("parse drive response: %w", err))
		return
	}

	// Auto-share permission: Set "anyone with the link can edit/view"
	// This allows the iframe in split view to immediately load and edit without login or cookie blocks!
	shouldShare := true
	if body.AutoShare != nil {
		shouldShare = *body.AutoShare
	}
	if shouldShare {
		role := strings.TrimSpace(body.ShareRole)
		if role == "" {
			role = "writer" // default: editor access so user can type immediately in split view
		}
		permURL := fmt.Sprintf("https://www.googleapis.com/drive/v3/files/%s/permissions", url.PathEscape(driveResp.ID))
		permPayload, _ := json.Marshal(map[string]string{
			"role": role,
			"type": "anyone",
		})
		permReq, err := http.NewRequestWithContext(ctx, "POST", permURL, bytes.NewReader(permPayload))
		if err == nil {
			permReq.Header.Set("Authorization", "Bearer "+token)
			permReq.Header.Set("Content-Type", "application/json")
			permResp, err := client.Do(permReq)
			if err == nil {
				permResp.Body.Close()
			}
		}
	}

	// Post-creation enforcement: Call Google Docs REST API to ensure 100% Times New Roman across the entire document
	// while PRESERVING bold, italic, and heading font weights
	go func(docID, authToken string) {
		gdocsReqURL := fmt.Sprintf("https://docs.googleapis.com/v1/documents/%s", url.PathEscape(docID))
		infoReq, err := http.NewRequest("GET", gdocsReqURL, nil)
		if err != nil {
			return
		}
		infoReq.Header.Set("Authorization", "Bearer "+authToken)
		c := &http.Client{Timeout: 15 * time.Second}
		infoResp, err := c.Do(infoReq)
		if err != nil {
			return
		}
		defer infoResp.Body.Close()

		var gdoc struct {
			Body struct {
				Content []struct {
					StartIndex int `json:"startIndex"`
					EndIndex   int `json:"endIndex"`
					Paragraph  *struct {
						ParagraphStyle *struct {
							NamedStyleType string `json:"namedStyleType"`
						} `json:"paragraphStyle"`
						Elements []struct {
							StartIndex int `json:"startIndex"`
							EndIndex   int `json:"endIndex"`
							TextRun    *struct {
								Content   string `json:"content"`
								TextStyle *struct {
									Bold   bool `json:"bold"`
									Italic bool `json:"italic"`
								} `json:"textStyle"`
							} `json:"textRun"`
						} `json:"elements"`
					} `json:"paragraph"`
				} `json:"content"`
			} `json:"body"`
		}
		if err := json.NewDecoder(infoResp.Body).Decode(&gdoc); err != nil || len(gdoc.Body.Content) == 0 {
			return
		}

		var reqs []map[string]any

		for _, item := range gdoc.Body.Content {
			if item.Paragraph == nil {
				continue
			}
			isHeading := item.Paragraph.ParagraphStyle != nil && strings.HasPrefix(item.Paragraph.ParagraphStyle.NamedStyleType, "HEADING_")

			for _, el := range item.Paragraph.Elements {
				if el.TextRun == nil || el.StartIndex >= el.EndIndex {
					continue
				}
				isBold := isHeading
				isItalic := false
				if el.TextRun.TextStyle != nil {
					if el.TextRun.TextStyle.Bold {
						isBold = true
					}
					if el.TextRun.TextStyle.Italic {
						isItalic = true
					}
				}

				textStyle := map[string]any{
					"weightedFontFamily": map[string]any{
						"fontFamily": "Times New Roman",
						"weight":     400,
					},
					"bold":   isBold,
					"italic": isItalic,
				}
				if isBold {
					textStyle["weightedFontFamily"] = map[string]any{
						"fontFamily": "Times New Roman",
						"weight":     700,
					}
				}

				reqs = append(reqs, map[string]any{
					"updateTextStyle": map[string]any{
						"range": map[string]any{
							"startIndex": el.StartIndex,
							"endIndex":   el.EndIndex,
						},
						"textStyle": textStyle,
						"fields":    "weightedFontFamily,bold,italic",
					},
				})
			}
		}

		if len(reqs) == 0 {
			return
		}

		// Execute in batches if there are many elements
		batchReq := map[string]any{"requests": reqs}
		bBytes, _ := json.Marshal(batchReq)
		upReq, err := http.NewRequest("POST", fmt.Sprintf("https://docs.googleapis.com/v1/documents/%s:batchUpdate", url.PathEscape(docID)), bytes.NewReader(bBytes))
		if err == nil {
			upReq.Header.Set("Authorization", "Bearer "+authToken)
			upReq.Header.Set("Content-Type", "application/json")
			upResp, err := c.Do(upReq)
			if err == nil {
				upResp.Body.Close()
			}
		}
	}(driveResp.ID, token)

	docURL := fmt.Sprintf("https://docs.google.com/document/d/%s/edit", driveResp.ID)

	// Automatically update research.gdocs.document_url and document_id in config
	cfg, err := config.Reload()
	if err == nil {
		cfg.Research.GDocs.DocumentURL = docURL
		cfg.Research.GDocs.DocumentID = driveResp.ID
		_ = config.Save(cfg)
		_ = s.applyReload()
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"status":       "success",
		"document_id":  driveResp.ID,
		"document_url": docURL,
		"title":        driveResp.Name,
	})
}

func (s *Server) handleGDocsSyncPush(w http.ResponseWriter, r *http.Request) {
	if s.requireDashboardPassword(w, r) {
		return
	}
	ctx := r.Context()
	var body struct {
		DocumentID string `json:"document_id"`
		HTML       string `json:"html"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	targetID := strings.TrimSpace(body.DocumentID)
	if targetID == "" {
		cfg := s.config()
		targetID = strings.TrimSpace(cfg.Research.GDocs.DocumentID)
		if targetID == "" && cfg.Research.GDocs.DocumentURL != "" {
			targetID = extractGoogleDocID(cfg.Research.GDocs.DocumentURL)
		}
	}
	if targetID == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("document_id is required for sync push"))
		return
	}

	contentHTML := strings.TrimSpace(body.HTML)
	if contentHTML == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("html content cannot be empty"))
		return
	}

	token, err := tools.ResolveActiveGoogleToken(ctx, s.config(), s.db)
	if err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("Google account is not connected: %w", err))
		return
	}

	// Update existing file content on Google Drive via PATCH multipart upload
	boundary := fmt.Sprintf("-------AntaresSyncBoundary%d", time.Now().UnixNano())
	var b bytes.Buffer

	// Part 1: Metadata JSON (Empty or preserves mimeType)
	b.WriteString(fmt.Sprintf("--%s\r\n", boundary))
	b.WriteString("Content-Type: application/json; charset=UTF-8\r\n\r\n")
	b.WriteString("{}\r\n")

	// Part 2: HTML Content
	b.WriteString(fmt.Sprintf("--%s\r\n", boundary))
	b.WriteString("Content-Type: text/html; charset=UTF-8\r\n\r\n")
	b.WriteString(contentHTML)
	b.WriteString(fmt.Sprintf("\r\n--%s--\r\n", boundary))

	patchURL := fmt.Sprintf("https://www.googleapis.com/upload/drive/v3/files/%s?uploadType=multipart", url.PathEscape(targetID))
	req, err := http.NewRequestWithContext(ctx, "PATCH", patchURL, &b)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("create drive patch request: %w", err))
		return
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", fmt.Sprintf("multipart/related; boundary=%s", boundary))

	client := &http.Client{Timeout: 45 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("send request to Google Drive: %w", err))
		return
	}
	defer resp.Body.Close()

	respBytes, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		writeError(w, http.StatusBadRequest, fmt.Errorf("Google Drive API patch error (%d): %s", resp.StatusCode, string(respBytes)))
		return
	}

	docURL := fmt.Sprintf("https://docs.google.com/document/d/%s/edit", targetID)

	writeJSON(w, http.StatusOK, map[string]any{
		"status":       "success",
		"document_id":  targetID,
		"document_url": docURL,
		"message":      "Isi Google Docs berhasil diperbarui mengikuti draf terbaru!",
	})
}

func (s *Server) handleGDocsSyncPull(w http.ResponseWriter, r *http.Request) {
	if s.requireDashboardPassword(w, r) {
		return
	}
	ctx := r.Context()
	var body struct {
		DocumentID string `json:"document_id"`
	}
	_ = decodeBody(r, &body)

	targetID := strings.TrimSpace(body.DocumentID)
	if targetID == "" {
		cfg := s.config()
		targetID = strings.TrimSpace(cfg.Research.GDocs.DocumentID)
		if targetID == "" && cfg.Research.GDocs.DocumentURL != "" {
			targetID = extractGoogleDocID(cfg.Research.GDocs.DocumentURL)
		}
	}
	if targetID == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("document_id is required for sync pull"))
		return
	}

	readTool, ok := tools.Default().Get("gdocs_read")
	if !ok {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("gdocs_read tool is not registered"))
		return
	}

	argsJSON, _ := json.Marshal(map[string]any{"document_id": targetID})
	res := readTool.Execute(ctx, tools.Input{
		Args: argsJSON,
		Deps: &tools.Deps{
			Config: s.config(),
			Store:  s.db,
		},
	})

	if res.IsError {
		writeError(w, http.StatusBadRequest, fmt.Errorf("%s", res.Content))
		return
	}

	// Clean out the header "Google Doc: Title (ID: ...)\n\n" from the extracted content
	raw := res.Content
	content := raw
	if idx := strings.Index(raw, "\n\n"); idx != -1 {
		content = strings.TrimSpace(raw[idx+2:])
	}

	// Update the local draft in Antares database
	_ = s.db.SetKV(ctx, "research:draft:content", content)

	writeJSON(w, http.StatusOK, map[string]any{
		"status":      "success",
		"document_id": targetID,
		"content":     content,
		"message":     "Berhasil menarik perubahan terbaru dari Google Docs ke Draf Naskah!",
	})
}

func (s *Server) handleGetDraft(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	title, _ := s.db.GetKV(ctx, "research:draft:title")
	content, _ := s.db.GetKV(ctx, "research:draft:content")
	if title == "" {
		title = "Bab 3 - Perancangan Sistem Bilik"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"title":   title,
		"content": content,
	})
}

func (s *Server) handleSaveDraft(w http.ResponseWriter, r *http.Request) {
	if s.requireDashboardPassword(w, r) {
		return
	}
	ctx := r.Context()
	var body struct {
		Title   string `json:"title"`
		Content string `json:"content"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if body.Title != "" {
		_ = s.db.SetKV(ctx, "research:draft:title", body.Title)
	}
	_ = s.db.SetKV(ctx, "research:draft:content", body.Content)
	writeJSON(w, http.StatusOK, map[string]any{"status": "saved"})
}

func (s *Server) handleOpenBrowser(w http.ResponseWriter, r *http.Request) {
	var body struct {
		URL string `json:"url"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	target := strings.TrimSpace(body.URL)
	if target == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("url cannot be empty"))
		return
	}

	// Strictly validate URL to prevent command injection, flag injection, and local file access
	if strings.HasPrefix(target, "-") {
		writeError(w, http.StatusBadRequest, fmt.Errorf("security violation: URL cannot begin with a dash"))
		return
	}
	u, err := url.ParseRequestURI(target)
	if err != nil || u.Host == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("security violation: malformed URL: %w", err))
		return
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "https" && scheme != "http" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("security violation: unsupported URL scheme %q; only http/https are permitted", scheme))
		return
	}

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "linux":
		cmd = exec.Command("xdg-open", target)
	case "darwin":
		cmd = exec.Command("open", target)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", target)
	default:
		cmd = exec.Command("xdg-open", target)
	}
	if cmd != nil {
		_ = cmd.Start()
	}

	writeJSON(w, http.StatusOK, map[string]any{"status": "opened", "url": target})
}
