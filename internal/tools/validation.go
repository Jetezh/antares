package tools

import (
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strings"
)

var (
	docIDRegex        = regexp.MustCompile(`^[a-zA-Z0-9_-]{20,100}$`)
	googleClientRegex = regexp.MustCompile(`^[0-9]+-[a-zA-Z0-9_]{10,}\.apps\.googleusercontent\.com$`)
	googleSecretRegex = regexp.MustCompile(`^[a-zA-Z0-9_-]{20,80}$`)
	zoteroUserIDRegex = regexp.MustCompile(`^[0-9]{1,12}$`)
	zoteroAPIKeyRegex = regexp.MustCompile(`^[a-zA-Z0-9]{16,32}$`)
	zoteroItemKeyRegex = regexp.MustCompile(`^[a-zA-Z0-9]{8}$`)

	// AllowInsecureTestWebhook is enabled only during internal unit test suites
	AllowInsecureTestWebhook = false
)

// ValidateGDocsWebhookURL enforces strict anti-SSRF rules on Apps Script webhooks.
func ValidateGDocsWebhookURL(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fmt.Errorf("webhook URL cannot be empty")
	}

	if AllowInsecureTestWebhook && (strings.HasPrefix(raw, "http://127.0.0.1") || strings.HasPrefix(raw, "http://localhost")) {
		return nil
	}

	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("invalid webhook URL syntax: %w", err)
	}

	// 1. Must use HTTPS
	if strings.ToLower(u.Scheme) != "https" {
		return fmt.Errorf("security violation: webhook URL must use HTTPS, got %q", u.Scheme)
	}

	// 2. Reject raw IP addresses (e.g. 169.254.169.254, 127.0.0.1)
	hostname := strings.ToLower(u.Hostname())
	if net.ParseIP(hostname) != nil {
		return fmt.Errorf("security violation: webhook cannot point to IP address %q", hostname)
	}

	// 3. Strict host whitelist: only script.google.com
	if hostname != "script.google.com" && !strings.HasSuffix(hostname, ".script.google.com") {
		return fmt.Errorf("security violation: webhook host must be script.google.com, got %q", hostname)
	}

	// 4. Path must be a valid Google Apps Script Web App endpoint (/macros/s/...)
	if !strings.HasPrefix(u.Path, "/macros/s/") || len(u.Path) < len("/macros/s/")+10 {
		return fmt.Errorf("security violation: webhook path must start with /macros/s/<deployment-id>, got %q", u.Path)
	}

	return nil
}

// ValidateGDocsDocID ensures the document ID is a clean alphanumeric string.
func ValidateGDocsDocID(id string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return fmt.Errorf("Google Docs document ID cannot be empty")
	}
	if !docIDRegex.MatchString(id) {
		return fmt.Errorf("security violation: invalid Google Docs document ID format: %q", id)
	}
	return nil
}

// ValidateGoogleOAuthCreds ensures OAuth Client ID and Secret conform to expected formats and do not inject CRLF.
func ValidateGoogleOAuthCreds(clientID, clientSecret string) error {
	clientID = strings.TrimSpace(clientID)
	clientSecret = strings.TrimSpace(clientSecret)

	if strings.ContainsAny(clientID, "\r\n") || strings.ContainsAny(clientSecret, "\r\n") {
		return fmt.Errorf("security violation: credentials must not contain newline characters (CRLF)")
	}

	if clientID != "" && !googleClientRegex.MatchString(clientID) {
		return fmt.Errorf("invalid Google OAuth Client ID format (must end with .apps.googleusercontent.com)")
	}

	if clientSecret != "" && !googleSecretRegex.MatchString(clientSecret) {
		return fmt.Errorf("invalid Google OAuth Client Secret format (expected alphanumeric/dash string)")
	}

	return nil
}

// ValidateZoteroCreds ensures Zotero User ID and API Key are clean and well-formed.
func ValidateZoteroCreds(userID, apiKey string) error {
	userID = strings.TrimSpace(userID)
	apiKey = strings.TrimSpace(apiKey)

	if userID != "" && !zoteroUserIDRegex.MatchString(userID) {
		return fmt.Errorf("security violation: Zotero User ID must be a numeric integer, got %q", userID)
	}

	if apiKey != "" && !zoteroAPIKeyRegex.MatchString(apiKey) {
		return fmt.Errorf("security violation: Zotero API Key must be a 16-32 character alphanumeric token, got %q", apiKey)
	}

	return nil
}

// ValidateZoteroItemKeys validates item keys for citing.
func ValidateZoteroItemKeys(keys []string) error {
	if len(keys) == 0 {
		return fmt.Errorf("item keys cannot be empty")
	}
	for _, k := range keys {
		k = strings.TrimSpace(k)
		if !zoteroItemKeyRegex.MatchString(k) {
			return fmt.Errorf("security violation: invalid Zotero item key format: %q", k)
		}
	}
	return nil
}
