package tools

import (
	"strings"
	"testing"
)

func TestGDocsRejectSSRF(t *testing.T) {
	dangerousURLs := []struct {
		url  string
		desc string
	}{
		{"http://169.254.169.254/latest/meta-data/", "AWS Cloud Metadata SSRF"},
		{"http://127.0.0.1:8790/api/config", "Localhost Internal Port SSRF"},
		{"http://localhost:8790/api/status", "Localhost Named SSRF"},
		{"https://attacker.com/macros/s/AKfycbx123456789/exec", "Foreign domain phishing/SSRF"},
		{"http://script.google.com/macros/s/AKfycbx123456789/exec", "Insecure HTTP scheme"},
		{"javascript:alert(1)", "JavaScript URI Scheme"},
		{"data:text/html,<script>alert(1)</script>", "Data URI Scheme"},
		{"file:///etc/passwd", "Local file scheme"},
		{"https://script.google.com/evil/path", "Invalid path not in /macros/s/"},
	}

	for _, tc := range dangerousURLs {
		t.Run(tc.desc, func(t *testing.T) {
			err := ValidateGDocsWebhookURL(tc.url)
			if err == nil {
				t.Fatalf("expected error for dangerous URL %q (%s), got nil", tc.url, tc.desc)
			}
			if !strings.Contains(err.Error(), "security violation") && !strings.Contains(err.Error(), "invalid") {
				t.Errorf("expected security violation error message, got %v", err)
			}
		})
	}

	// Valid Google Apps Script Webhook
	validURL := "https://script.google.com/macros/s/AKfycbx1234567890abcdefghijklmnopqrstuvwxyz/exec"
	if err := ValidateGDocsWebhookURL(validURL); err != nil {
		t.Fatalf("expected valid webhook to pass, got: %v", err)
	}
}

func TestGDocsDocIDSanitization(t *testing.T) {
	invalidIDs := []string{
		"../../etc/passwd",
		"<script>alert(1)</script>",
		"id with spaces",
		"id/with/slashes",
		"short",
		"id_with_special!@#$%^&*()",
	}

	for _, id := range invalidIDs {
		if err := ValidateGDocsDocID(id); err == nil {
			t.Errorf("expected error for invalid Doc ID %q, got nil", id)
		}
	}

	validID := "1U76qmDw7ZDiSZJmCk5_Ri8VfdFKZZYyTTKpSeSaio6o"
	if err := ValidateGDocsDocID(validID); err != nil {
		t.Fatalf("expected valid Doc ID to pass, got: %v", err)
	}
}

func TestGoogleOAuthCredsValidation(t *testing.T) {
	// CRLF injection attempts
	if err := ValidateGoogleOAuthCreds("client\r\nid", "secret"); err == nil {
		t.Error("expected error on CRLF in client_id")
	}
	if err := ValidateGoogleOAuthCreds("client_id", "secret\r\n"); err == nil {
		t.Error("expected error on CRLF in client_secret")
	}

	// Non-Google client ID
	if err := ValidateGoogleOAuthCreds("12345-abc.malicious.com", "valid_secret_1234567890"); err == nil {
		t.Error("expected error on client ID not ending with .apps.googleusercontent.com")
	}

	// Valid Google client ID and secret
	validClientID := "123456789012-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com"
	validSecret := "mockclientsecretvalue1234567890abcdef"
	if err := ValidateGoogleOAuthCreds(validClientID, validSecret); err != nil {
		t.Fatalf("expected valid credentials to pass, got: %v", err)
	}
}
