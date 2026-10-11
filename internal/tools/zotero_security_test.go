package tools

import (
	"testing"
)

func TestZoteroSecurityValidation(t *testing.T) {
	// 1. User ID validation
	invalidUserIDs := []string{
		"1585/../evil",
		"admin",
		"-12345",
		"1585 1659",
		"1585; DROP TABLE users;",
	}
	for _, id := range invalidUserIDs {
		if err := ValidateZoteroCreds(id, "valid_token_12345678"); err == nil {
			t.Errorf("expected error for invalid User ID %q, got nil", id)
		}
	}

	// 2. API Key validation
	invalidKeys := []string{
		"key with spaces",
		"key/with/slashes",
		"short",
		"key_with_special!@#$",
		"key\r\ninjection",
	}
	for _, k := range invalidKeys {
		if err := ValidateZoteroCreds("15851659", k); err == nil {
			t.Errorf("expected error for invalid API Key %q, got nil", k)
		}
	}

	// 3. Valid credentials
	if err := ValidateZoteroCreds("12345678", "syntheticmockkey123456"); err != nil {
		t.Fatalf("expected valid Zotero credentials to pass, got: %v", err)
	}

	// 4. Item keys validation
	if err := ValidateZoteroItemKeys([]string{"UXDB5SN6", "VD586K78"}); err != nil {
		t.Fatalf("expected valid item keys to pass, got: %v", err)
	}

	invalidItemKeys := [][]string{
		{"short"},
		{"UXDB5SN6;DROP"},
		{"../traversal"},
		{"invalid_len_12345"},
	}
	for _, keys := range invalidItemKeys {
		if err := ValidateZoteroItemKeys(keys); err == nil {
			t.Errorf("expected error for invalid item keys %v, got nil", keys)
		}
	}
}
