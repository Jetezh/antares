package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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
	writeJSON(w, http.StatusOK, map[string]any{
		"zotero": map[string]any{
			"user_id": cfg.Research.Zotero.UserID,
			"api_key": cfg.Research.Zotero.APIKey,
		},
		"gdocs": map[string]any{
			"method":              cfg.Research.GDocs.Method,
			"webhook_url":         cfg.Research.GDocs.WebhookURL,
			"document_url":        cfg.Research.GDocs.DocumentURL,
			"document_id":         cfg.Research.GDocs.DocumentID,
			"oauth_client_id":     cfg.Research.GDocs.OAuthClientID,
			"oauth_client_secret": cfg.Research.GDocs.OAuthClientSecret,
		},
	})
}

func (s *Server) handleSaveResearchSettings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Zotero struct {
			UserID string `json:"user_id"`
			APIKey string `json:"api_key"`
		} `json:"zotero"`
		GDocs struct {
			Method            string `json:"method"`
			WebhookURL        string `json:"webhook_url"`
			DocumentURL       string `json:"document_url"`
			OAuthClientID     string `json:"oauth_client_id"`
			OAuthClientSecret string `json:"oauth_client_secret"`
		} `json:"gdocs"`
	}

	if err := decodeBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	// Security validation on all incoming inputs
	if body.Zotero.UserID != "" || body.Zotero.APIKey != "" {
		if err := tools.ValidateZoteroCreds(body.Zotero.UserID, body.Zotero.APIKey); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
	}
	if body.GDocs.WebhookURL != "" {
		if err := tools.ValidateGDocsWebhookURL(body.GDocs.WebhookURL); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
	}
	if body.GDocs.DocumentURL != "" {
		docID := extractGoogleDocID(body.GDocs.DocumentURL)
		if err := tools.ValidateGDocsDocID(docID); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
	}
	if body.GDocs.OAuthClientID != "" || body.GDocs.OAuthClientSecret != "" {
		if err := tools.ValidateGoogleOAuthCreds(body.GDocs.OAuthClientID, body.GDocs.OAuthClientSecret); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
	}

	cfg, err := config.Reload()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	if body.Zotero.UserID != "" {
		cfg.Research.Zotero.UserID = body.Zotero.UserID
	}
	if body.Zotero.APIKey != "" {
		cfg.Research.Zotero.APIKey = body.Zotero.APIKey
	}
	if body.GDocs.Method != "" {
		cfg.Research.GDocs.Method = body.GDocs.Method
	}
	if body.GDocs.WebhookURL != "" {
		cfg.Research.GDocs.WebhookURL = body.GDocs.WebhookURL
	}
	if body.GDocs.DocumentURL != "" {
		cfg.Research.GDocs.DocumentURL = body.GDocs.DocumentURL
		cfg.Research.GDocs.DocumentID = extractGoogleDocID(body.GDocs.DocumentURL)
	}
	if body.GDocs.OAuthClientID != "" {
		cfg.Research.GDocs.OAuthClientID = body.GDocs.OAuthClientID
	}
	if body.GDocs.OAuthClientSecret != "" {
		cfg.Research.GDocs.OAuthClientSecret = body.GDocs.OAuthClientSecret
	}

	if err := config.Save(cfg); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	_ = s.applyReload()

	writeJSON(w, http.StatusOK, map[string]any{"status": "saved"})
}

func (s *Server) handleGDocsRollback(w http.ResponseWriter, r *http.Request) {
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
	ctx := r.Context()
	var body struct {
		Title string `json:"title"`
		HTML  string `json:"html"`
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
