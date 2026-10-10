package server

import (
	"net/http"
	"strings"

	"github.com/enowdev/antares/internal/config"
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
