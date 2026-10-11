package server

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/enowdev/antares/internal/config"
)

func TestResearchSettingsValidationAPI(t *testing.T) {
	t.Setenv("ANTARES_HOME", t.TempDir())
	cfg := config.Default()
	s := &Server{cfg: cfg}

	// 1. Rejects SSRF Webhook URL
	ssrfPayload := `{"gdocs":{"webhook_url":"http://169.254.169.254/latest/meta-data"}}`
	req := httptest.NewRequest(http.MethodPost, "/api/research/settings", bytes.NewBufferString(ssrfPayload))
	rr := httptest.NewRecorder()
	s.handleSaveResearchSettings(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request on SSRF webhook, got %d", rr.Code)
	}

	// 2. Rejects malicious Zotero User ID
	badZoteroPayload := `{"zotero":{"user_id":"123/../evil","api_key":"valid_token_12345"}}`
	req = httptest.NewRequest(http.MethodPost, "/api/research/settings", bytes.NewBufferString(badZoteroPayload))
	rr = httptest.NewRecorder()
	s.handleSaveResearchSettings(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request on malicious Zotero user ID, got %d", rr.Code)
	}

	// 3. Rejects invalid Document URL
	badDocPayload := `{"gdocs":{"document_url":"https://evil.com/phish"}}`
	req = httptest.NewRequest(http.MethodPost, "/api/research/settings", bytes.NewBufferString(badDocPayload))
	rr = httptest.NewRecorder()
	s.handleSaveResearchSettings(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request on invalid document URL, got %d", rr.Code)
	}

	// 4. Accepts valid settings
	validPayload := `{"zotero":{"user_id":"12345678","api_key":"syntheticmockkey123456"},"gdocs":{"method":"oauth","document_url":"https://docs.google.com/document/d/1U76qmDw7ZDiSZJmCk5_Ri8VfdFKZZYyTTKpSeSaio6o/edit"}}`
	req = httptest.NewRequest(http.MethodPost, "/api/research/settings", bytes.NewBufferString(validPayload))
	rr = httptest.NewRecorder()
	s.handleSaveResearchSettings(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 OK on valid settings, got %d (body: %s)", rr.Code, rr.Body.String())
	}
}
