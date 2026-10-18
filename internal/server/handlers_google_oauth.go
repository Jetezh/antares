package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const googleOAuthTokenURL = "https://oauth2.googleapis.com/token"

func getGoogleRedirectURI(r *http.Request) string {
	// If custom query redirect_uri is passed, validate it points strictly to callback endpoint and legitimate host
	if q := r.URL.Query().Get("redirect_uri"); q != "" {
		if u, err := url.Parse(q); err == nil && (strings.HasSuffix(u.Path, "/api/auth/google/callback") || u.Path == "/api/auth/google/callback") {
			host := u.Hostname()
			reqHost := r.Host
			if h, _, err := net.SplitHostPort(r.Host); err == nil {
				reqHost = h
			}
			if host == "" || host == reqHost || host == "localhost" || host == "127.0.0.1" {
				return q
			}
		}
	}
	// Prefer origin header from web frontend
	if origin := r.Header.Get("Origin"); origin != "" {
		if u, err := url.Parse(origin); err == nil && u.Host != "" {
			proto := u.Scheme
			if proto == "" {
				proto = "http"
			}
			return fmt.Sprintf("%s://%s/api/auth/google/callback", proto, u.Host)
		}
	}
	if referer := r.Header.Get("Referer"); referer != "" {
		if u, err := url.Parse(referer); err == nil && u.Host != "" {
			proto := u.Scheme
			if proto == "" {
				proto = "http"
			}
			return fmt.Sprintf("%s://%s/api/auth/google/callback", proto, u.Host)
		}
	}
	// Prefer host from request header
	host := r.Host
	if host == "" {
		host = "localhost:8787"
	}
	proto := "http"
	if r.TLS != nil {
		proto = "https"
	}
	return fmt.Sprintf("%s://%s/api/auth/google/callback", proto, host)
}

func (s *Server) handleGoogleOAuthURL(w http.ResponseWriter, r *http.Request) {
	if s.requireDashboardPassword(w, r) {
		return
	}
	cfg := s.config()
	clientID := strings.TrimSpace(cfg.Research.GDocs.OAuthClientID)
	if clientID == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("Google OAuth Client ID is not configured. Set it in Research Settings first."))
		return
	}

	redirectURI := getGoogleRedirectURI(r)
	scopes := []string{
		"https://www.googleapis.com/auth/documents",
		"https://www.googleapis.com/auth/drive.file",
	}

	// Mint a cryptographically secure random state nonce to prevent OAuth CSRF/login manipulation
	stateNonce := newID("gstate")
	_ = s.db.SetKV(r.Context(), "research:oauth:state:"+stateNonce, redirectURI)

	// Encode both redirectURI and stateNonce securely in state parameter
	stateVal := fmt.Sprintf("%s|%s", stateNonce, redirectURI)

	authURL := fmt.Sprintf(
		"https://accounts.google.com/o/oauth2/v2/auth?client_id=%s&redirect_uri=%s&response_type=code&scope=%s&access_type=offline&prompt=consent&state=%s",
		url.QueryEscape(clientID),
		url.QueryEscape(redirectURI),
		url.QueryEscape(strings.Join(scopes, " ")),
		url.QueryEscape(stateVal),
	)

	writeJSON(w, http.StatusOK, map[string]any{
		"url":          authURL,
		"redirect_uri": redirectURI,
	})
}

func (s *Server) handleGoogleOAuthCallback(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	code := r.URL.Query().Get("code")
	if code == "" {
		errMsg := r.URL.Query().Get("error")
		writeError(w, http.StatusBadRequest, fmt.Errorf("Google authorization denied or failed: %s", errMsg))
		return
	}

	cfg := s.config()
	clientID := strings.TrimSpace(cfg.Research.GDocs.OAuthClientID)
	clientSecret := strings.TrimSpace(cfg.Research.GDocs.OAuthClientSecret)
	if clientID == "" || clientSecret == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("Google OAuth Client ID or Secret is missing in config"))
		return
	}

	redirectURI := getGoogleRedirectURI(r)
	stateParam := r.URL.Query().Get("state")
	if stateParam == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("security violation: missing OAuth state parameter"))
		return
	}
	parts := strings.SplitN(stateParam, "|", 2)
	if len(parts) != 2 {
		writeError(w, http.StatusBadRequest, fmt.Errorf("security violation: malformed OAuth state token"))
		return
	}
	nonce := parts[0]
	expectedURI, _ := s.db.GetKV(ctx, "research:oauth:state:"+nonce)
	if expectedURI == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("security violation: invalid or expired OAuth state token (potential CSRF)"))
		return
	}
	// One-time use: delete validated state nonce
	_ = s.db.SetKV(ctx, "research:oauth:state:"+nonce, "")
	redirectURI = parts[1]

	// Exchange code for tokens
	data := url.Values{}
	data.Set("code", code)
	data.Set("client_id", clientID)
	data.Set("client_secret", clientSecret)
	data.Set("redirect_uri", redirectURI)
	data.Set("grant_type", "authorization_code")

	resp, err := http.PostForm(googleOAuthTokenURL, data)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("token exchange request failed: %w", err))
		return
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		writeError(w, http.StatusBadRequest, fmt.Errorf("Google token exchange error (%d): %s", resp.StatusCode, string(bodyBytes)))
		return
	}

	var tokenResp struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
		TokenType    string `json:"token_type"`
		Scope        string `json:"scope"`
	}
	if err := json.Unmarshal(bodyBytes, &tokenResp); err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("failed to parse token response: %w", err))
		return
	}

	if tokenResp.AccessToken == "" {
		writeError(w, http.StatusInternalServerError, fmt.Errorf("no access token received from Google"))
		return
	}

	// Persist tokens securely in database
	_ = s.db.SetKV(ctx, "research:gdocs:access_token", tokenResp.AccessToken)
	if tokenResp.RefreshToken != "" {
		_ = s.db.SetKV(ctx, "research:gdocs:refresh_token", tokenResp.RefreshToken)
	}
	expiresAt := time.Now().Add(time.Duration(tokenResp.ExpiresIn) * time.Second).Unix()
	_ = s.db.SetKV(ctx, "research:gdocs:token_expiry", strconv.FormatInt(expiresAt, 10))

	// Return a clean self-closing HTML callback page that notifies parent window
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	html := `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Google Docs Connected</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0b0f17; color: #f8fafc; }
    .card { background: #1e293b; padding: 2rem; border-radius: 12px; text-align: center; max-width: 400px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); border: 1px solid #334155; }
    h2 { color: #10b981; margin-top: 0; }
    p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Connected to Google Docs!</h2>
    <p>Akun Google berhasil dihubungkan ke Antares. Jendela ini akan tertutup otomatis dalam beberapa detik...</p>
  </div>
  <script>
    try {
      if (window.opener) {
        window.opener.postMessage({ type: 'antares:google-oauth-success' }, '*');
      }
    } catch (e) {}
    setTimeout(function() {
      window.close();
    }, 1500);
  </script>
</body>
</html>`
	_, _ = w.Write([]byte(html))
}

func (s *Server) handleGoogleOAuthStatus(w http.ResponseWriter, r *http.Request) {
	if s.requireDashboardPassword(w, r) {
		return
	}
	ctx := r.Context()
	cfg := s.config()
	clientID := strings.TrimSpace(cfg.Research.GDocs.OAuthClientID)
	hasClient := clientID != ""

	refreshToken, _ := s.db.GetKV(ctx, "research:gdocs:refresh_token")
	accessToken, _ := s.db.GetKV(ctx, "research:gdocs:access_token")

	connected := refreshToken != "" || accessToken != ""

	writeJSON(w, http.StatusOK, map[string]any{
		"connected":  connected,
		"has_client": hasClient,
	})
}

func (s *Server) handleGoogleOAuthDisconnect(w http.ResponseWriter, r *http.Request) {
	if s.requireDashboardPassword(w, r) {
		return
	}
	ctx := r.Context()
	_ = s.db.SetKV(ctx, "research:gdocs:access_token", "")
	_ = s.db.SetKV(ctx, "research:gdocs:refresh_token", "")
	_ = s.db.SetKV(ctx, "research:gdocs:token_expiry", "")
	writeJSON(w, http.StatusOK, map[string]any{"status": "disconnected"})
}

// FetchValidGoogleToken gets an active access token, refreshing if needed using refresh_token.
func FetchValidGoogleToken(ctx context.Context, clientID, clientSecret, accessToken, refreshToken string, expiresAtUnix int64) (string, error) {
	// If access token is still valid with > 2 minutes leeway, use it
	if accessToken != "" && time.Now().Unix() < (expiresAtUnix-120) {
		return accessToken, nil
	}

	if refreshToken == "" {
		if accessToken != "" {
			return accessToken, nil
		}
		return "", fmt.Errorf("not authenticated with Google OAuth. Please connect your Google account in Research Settings")
	}

	// Refresh token
	data := url.Values{}
	data.Set("client_id", clientID)
	data.Set("client_secret", clientSecret)
	data.Set("refresh_token", refreshToken)
	data.Set("grant_type", "refresh_token")

	req, err := http.NewRequestWithContext(ctx, "POST", googleOAuthTokenURL, strings.NewReader(data.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("token refresh request failed: %w", err)
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

	return res.AccessToken, nil
}
