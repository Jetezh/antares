package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

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
