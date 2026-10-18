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

	// 0. Gate: without password or auth token, must return 428 Precondition Required
	gateReq := httptest.NewRequest(http.MethodPost, "/api/research/settings", bytes.NewBufferString("{}"))
	gateRR := httptest.NewRecorder()
	s.handleSaveResearchSettings(gateRR, gateReq)
	if gateRR.Code != http.StatusPreconditionRequired {
		t.Fatalf("expected 428 Precondition Required when unauthenticated, got %d", gateRR.Code)
	}

	// Satisfy the password gate for subsequent validation checks
	cfg.Server.DashboardPasswordHash = "test-hash"

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

func TestResearchSettingsMaskingAndRoundTrip(t *testing.T) {
	t.Setenv("ANTARES_HOME", t.TempDir())
	cfg := config.Default()
	cfg.Server.DashboardPasswordHash = "test-hash"
	cfg.Research.Zotero.UserID = "12345678"
	cfg.Research.Zotero.APIKey = "supersecretzoterokey12345"
	cfg.Research.GDocs.OAuthClientID = "12345-abc.apps.googleusercontent.com"
	cfg.Research.GDocs.OAuthClientSecret = "GOCSPX-supersecret12345"
	s := &Server{cfg: cfg}

	// 1. GET settings must return masked secrets
	getReq := httptest.NewRequest(http.MethodGet, "/api/research/settings", nil)
	getRR := httptest.NewRecorder()
	s.handleGetResearchSettings(getRR, getReq)
	if getRR.Code != http.StatusOK {
		t.Fatalf("expected 200 OK on GET settings, got %d", getRR.Code)
	}
	body := getRR.Body.String()
	if bytes.Contains(getRR.Body.Bytes(), []byte("supersecretzoterokey12345")) {
		t.Fatalf("Zotero API key leaked in plaintext in response: %s", body)
	}
	if bytes.Contains(getRR.Body.Bytes(), []byte("GOCSPX-supersecret12345")) {
		t.Fatalf("Google OAuth client secret leaked in plaintext in response: %s", body)
	}

	// 2. POST with masked value should preserve existing secret
	postPayload := `{"zotero":{"api_key":"supe••••••••2345"},"gdocs":{"oauth_client_secret":"••••••••"}}`
	postReq := httptest.NewRequest(http.MethodPost, "/api/research/settings", bytes.NewBufferString(postPayload))
	postRR := httptest.NewRecorder()
	s.handleSaveResearchSettings(postRR, postReq)
	if postRR.Code != http.StatusOK {
		t.Fatalf("expected 200 OK on POST settings with masked secrets, got %d: %s", postRR.Code, postRR.Body.String())
	}
	if cfg.Research.Zotero.APIKey != "supersecretzoterokey12345" {
		t.Fatalf("expected Zotero API key to be preserved, got %q", cfg.Research.Zotero.APIKey)
	}
	if cfg.Research.GDocs.OAuthClientSecret != "GOCSPX-supersecret12345" {
		t.Fatalf("expected OAuth secret to be preserved, got %q", cfg.Research.GDocs.OAuthClientSecret)
	}
}

func TestGDocsSyncAndRollbackSecurity(t *testing.T) {
	t.Setenv("ANTARES_HOME", t.TempDir())
	cfg := config.Default()
	s := &Server{cfg: cfg}

	// 1. Unauthenticated requests must be gated by 428 Precondition Required
	syncReq := httptest.NewRequest(http.MethodPost, "/api/research/gdocs/sync", bytes.NewBufferString(`{"html":"test"}`))
	syncRR := httptest.NewRecorder()
	s.handleGDocsSyncPush(syncRR, syncReq)
	if syncRR.Code != http.StatusPreconditionRequired {
		t.Fatalf("expected 428 on unauthenticated sync push, got %d", syncRR.Code)
	}

	pullReq := httptest.NewRequest(http.MethodPost, "/api/research/gdocs/pull", bytes.NewBufferString(`{}`))
	pullRR := httptest.NewRecorder()
	s.handleGDocsSyncPull(pullRR, pullReq)
	if pullRR.Code != http.StatusPreconditionRequired {
		t.Fatalf("expected 428 on unauthenticated sync pull, got %d", pullRR.Code)
	}

	rbReq := httptest.NewRequest(http.MethodPost, "/api/research/gdocs/rollback", bytes.NewBufferString(`{}`))
	rbRR := httptest.NewRecorder()
	s.handleGDocsRollback(rbRR, rbReq)
	if rbRR.Code != http.StatusPreconditionRequired {
		t.Fatalf("expected 428 on unauthenticated rollback, got %d", rbRR.Code)
	}

	// Satisfy password gate for payload security checks
	cfg.Server.DashboardPasswordHash = "test-hash"

	// 2. Reject malicious document IDs (path traversal / SSRF injection)
	badIDs := []string{
		`{"document_id":"../../evil"}`,
		`{"document_id":"https://attacker.com/evil"}`,
		`{"document_id":"short"}`,
	}
	for _, bad := range badIDs {
		// Sync push
		r := httptest.NewRequest(http.MethodPost, "/api/research/gdocs/sync", bytes.NewBufferString(bad))
		w := httptest.NewRecorder()
		s.handleGDocsSyncPush(w, r)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 on malicious document_id %s in sync push, got %d", bad, w.Code)
		}

		// Sync pull
		r = httptest.NewRequest(http.MethodPost, "/api/research/gdocs/pull", bytes.NewBufferString(bad))
		w = httptest.NewRecorder()
		s.handleGDocsSyncPull(w, r)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 on malicious document_id %s in sync pull, got %d", bad, w.Code)
		}

		// Rollback
		r = httptest.NewRequest(http.MethodPost, "/api/research/gdocs/rollback", bytes.NewBufferString(bad))
		w = httptest.NewRecorder()
		s.handleGDocsRollback(w, r)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 on malicious document_id %s in rollback, got %d", bad, w.Code)
		}
	}
}

func TestOpenBrowserSecurity(t *testing.T) {
	t.Setenv("ANTARES_HOME", t.TempDir())
	cfg := config.Default()
	s := &Server{cfg: cfg}

	// 1. Password gate
	req := httptest.NewRequest(http.MethodPost, "/api/research/open-browser", bytes.NewBufferString(`{"url":"https://example.com"}`))
	rr := httptest.NewRecorder()
	s.handleOpenBrowser(rr, req)
	if rr.Code != http.StatusPreconditionRequired {
		t.Fatalf("expected 428 on unauthenticated open-browser, got %d", rr.Code)
	}

	cfg.Server.DashboardPasswordHash = "test-hash"

	// 2. Reject flag injection
	badFlag := `{"url":"--app=https://attacker.com"}`
	req = httptest.NewRequest(http.MethodPost, "/api/research/open-browser", bytes.NewBufferString(badFlag))
	rr = httptest.NewRecorder()
	s.handleOpenBrowser(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 on flag injection, got %d", rr.Code)
	}

	// 3. Reject non-http schemes
	schemes := []string{
		`{"url":"file:///etc/passwd"}`,
		`{"url":"javascript:alert(1)"}`,
		`{"url":"smb://attacker/share"}`,
	}
	for _, sc := range schemes {
		req = httptest.NewRequest(http.MethodPost, "/api/research/open-browser", bytes.NewBufferString(sc))
		rr = httptest.NewRecorder()
		s.handleOpenBrowser(rr, req)
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 on unsupported scheme %s, got %d", sc, rr.Code)
		}
	}
}
