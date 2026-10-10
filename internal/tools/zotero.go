package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Default Zotero API constants
const zoteroAPIBase = "https://api.zotero.org"

// resolveZoteroCreds resolves user_id and api_key from tool input, config, or environment.
func resolveZoteroCreds(in Input, argUserID, argAPIKey string) (userID, apiKey string, err error) {
	apiKey = strings.TrimSpace(argAPIKey)
	userID = strings.TrimSpace(argUserID)

	if in.Deps != nil && in.Deps.Config != nil {
		cfg := in.Deps.Config
		if apiKey == "" {
			apiKey = strings.TrimSpace(cfg.Research.Zotero.APIKey)
		}
		if userID == "" {
			userID = strings.TrimSpace(cfg.Research.Zotero.UserID)
		}
	}

	if apiKey == "" {
		return "", "", fmt.Errorf("zotero API key is required. Pass api_key or configure research.zotero.api_key in config")
	}

	// If userID is not provided, fetch it using the key info endpoint
	if userID == "" {
		resolvedID, err := fetchZoteroUserIDFromKey(apiKey)
		if err != nil {
			return "", "", fmt.Errorf("could not determine Zotero user ID from API key: %w", err)
		}
		userID = resolvedID
	}

	return userID, apiKey, nil
}

func fetchZoteroUserIDFromKey(apiKey string) (string, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	req, err := http.NewRequest("GET", fmt.Sprintf("%s/keys/%s", zoteroAPIBase, url.PathEscape(apiKey)), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Zotero-API-Key", apiKey)

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("key lookup returned status %d: %s", resp.StatusCode, string(body))
	}

	var keyInfo struct {
		UserID int `json:"userID"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&keyInfo); err != nil {
		return "", err
	}
	if keyInfo.UserID == 0 {
		return "", fmt.Errorf("received empty userID from key info")
	}
	return strconv.Itoa(keyInfo.UserID), nil
}

// StripHTML removes HTML tags from strings (useful for CSL bib/citation HTML).
func stripHTML(input string) string {
	re := regexp.MustCompile("<[^>]*>")
	cleaned := re.ReplaceAllString(input, "")
	cleaned = strings.ReplaceAll(cleaned, "&nbsp;", " ")
	cleaned = strings.ReplaceAll(cleaned, "&amp;", "&")
	cleaned = strings.ReplaceAll(cleaned, "&lt;", "<")
	cleaned = strings.ReplaceAll(cleaned, "&gt;", ">")
	cleaned = strings.ReplaceAll(cleaned, "&quot;", "\"")
	cleaned = strings.ReplaceAll(cleaned, "&#x2019;", "'")
	cleaned = strings.ReplaceAll(cleaned, "&#x2018;", "'")
	cleaned = strings.ReplaceAll(cleaned, "&#x201C;", "\"")
	cleaned = strings.ReplaceAll(cleaned, "&#x201D;", "\"")
	return strings.TrimSpace(cleaned)
}

// -----------------------------------------------------------------------------
// 1. zotero_collections
// -----------------------------------------------------------------------------

type zoteroCollectionsTool struct{}

func (zoteroCollectionsTool) Name() string { return "zotero_collections" }
func (zoteroCollectionsTool) Description() string {
	return "List all research collections/folders in Zotero. Shows collection keys, names, item counts, and hierarchical relationships. Use this to locate specific research topics or target libraries before searching papers."
}
func (zoteroCollectionsTool) RequiresApproval() bool { return false }

func (zoteroCollectionsTool) Schema() map[string]any {
	return schema(map[string]any{
		"user_id": prop("string", "Zotero User ID (optional if configured or detected from api_key)."),
		"api_key": prop("string", "Zotero API Key (optional if configured in settings)."),
	})
}

func (zoteroCollectionsTool) Execute(ctx context.Context, in Input) Result {
	var args struct {
		UserID string `json:"user_id"`
		APIKey string `json:"api_key"`
	}
	if err := in.Bind(&args); err != nil {
		return Errorf("%v", err)
	}

	userID, apiKey, err := resolveZoteroCreds(in, args.UserID, args.APIKey)
	if err != nil {
		return Errorf("%v", err)
	}

	reqURL := fmt.Sprintf("%s/users/%s/collections", zoteroAPIBase, url.PathEscape(userID))
	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return Errorf("create request: %v", err)
	}
	req.Header.Set("Zotero-API-Key", apiKey)

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return Errorf("fetch collections: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return Errorf("Zotero API error (%d): %s", resp.StatusCode, string(b))
	}

	var raw []struct {
		Key  string `json:"key"`
		Meta struct {
			NumCollections int `json:"numCollections"`
			NumItems       int `json:"numItems"`
		} `json:"meta"`
		Data struct {
			Name             string `json:"name"`
			ParentCollection any    `json:"parentCollection"`
		} `json:"data"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return Errorf("decode collections: %v", err)
	}

	if len(raw) == 0 {
		return Text("No collections found in Zotero library.")
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Found %d Zotero Collections (User %s):\n\n", len(raw), userID))
	for _, c := range raw {
		parentStr := ""
		if c.Data.ParentCollection != nil && c.Data.ParentCollection != false {
			parentStr = fmt.Sprintf(" (parent: %v)", c.Data.ParentCollection)
		}
		sb.WriteString(fmt.Sprintf("• [%s] %s%s - %d items\n", c.Key, c.Data.Name, parentStr, c.Meta.NumItems))
	}

	return Text(strings.TrimSpace(sb.String()))
}

// -----------------------------------------------------------------------------
// 2. zotero_search
// -----------------------------------------------------------------------------

type zoteroSearchTool struct{}

func (zoteroSearchTool) Name() string { return "zotero_search" }
func (zoteroSearchTool) Description() string {
	return "Search papers, books, articles, and citations in Zotero. Supports searching across the entire library or filtering within a specific collection key. Returns titles, authors, years, publication, DOI, and abstract snippets."
}
func (zoteroSearchTool) RequiresApproval() bool { return false }

func (zoteroSearchTool) Schema() map[string]any {
	return schema(map[string]any{
		"query":          prop("string", "Search query (keyword, title, author, or DOI)."),
		"collection_key": prop("string", "Optional collection key to search within a specific folder."),
		"limit":          propDefault("integer", "Maximum number of items to return (1 to 25, default 10).", 10),
		"user_id":        prop("string", "Zotero User ID (optional)."),
		"api_key":        prop("string", "Zotero API Key (optional)."),
	})
}

func (zoteroSearchTool) Execute(ctx context.Context, in Input) Result {
	var args struct {
		Query         string `json:"query"`
		CollectionKey string `json:"collection_key"`
		Limit         int    `json:"limit"`
		UserID        string `json:"user_id"`
		APIKey        string `json:"api_key"`
	}
	if err := in.Bind(&args); err != nil {
		return Errorf("%v", err)
	}

	userID, apiKey, err := resolveZoteroCreds(in, args.UserID, args.APIKey)
	if err != nil {
		return Errorf("%v", err)
	}

	if args.Limit <= 0 {
		args.Limit = 10
	}
	if args.Limit > 25 {
		args.Limit = 25
	}

	baseURL := fmt.Sprintf("%s/users/%s/items", zoteroAPIBase, url.PathEscape(userID))
	if strings.TrimSpace(args.CollectionKey) != "" {
		baseURL = fmt.Sprintf("%s/users/%s/collections/%s/items", zoteroAPIBase, url.PathEscape(userID), url.PathEscape(strings.TrimSpace(args.CollectionKey)))
	}

	params := url.Values{}
	params.Set("limit", strconv.Itoa(args.Limit))
	params.Set("itemType", "-attachment") // exclude standalone attachments to focus on citation items
	if strings.TrimSpace(args.Query) != "" {
		params.Set("q", strings.TrimSpace(args.Query))
	}

	reqURL := fmt.Sprintf("%s?%s", baseURL, params.Encode())
	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return Errorf("create request: %v", err)
	}
	req.Header.Set("Zotero-API-Key", apiKey)

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return Errorf("execute search: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return Errorf("Zotero API error (%d): %s", resp.StatusCode, string(b))
	}

	var raw []struct {
		Key  string `json:"key"`
		Meta struct {
			CreatorSummary string `json:"creatorSummary"`
			ParsedDate     string `json:"parsedDate"`
		} `json:"meta"`
		Data struct {
			ItemType string `json:"itemType"`
			Title    string `json:"title"`
			Date     string `json:"date"`
			DOI      string `json:"DOI"`
			URL      string `json:"url"`
			Abstract string `json:"abstractNote"`
			Creators []struct {
				CreatorType string `json:"creatorType"`
				FirstName   string `json:"firstName"`
				LastName    string `json:"lastName"`
				Name        string `json:"name"`
			} `json:"creators"`
			PublicationTitle string `json:"publicationTitle"`
		} `json:"data"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return Errorf("decode search results: %v", err)
	}

	if len(raw) == 0 {
		return Text("No items found matching the search criteria in Zotero.")
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Found %d Zotero Items:\n\n", len(raw)))
	for i, item := range raw {
		authors := item.Meta.CreatorSummary
		if authors == "" {
			var authorList []string
			for _, c := range item.Data.Creators {
				if c.LastName != "" {
					authorList = append(authorList, c.LastName)
				} else if c.Name != "" {
					authorList = append(authorList, c.Name)
				}
			}
			authors = strings.Join(authorList, ", ")
		}
		if authors == "" {
			authors = "Unknown author"
		}

		year := item.Meta.ParsedDate
		if year == "" {
			year = item.Data.Date
		}
		if year == "" {
			year = "n.d."
		}

		sb.WriteString(fmt.Sprintf("%d. [%s] \"%s\"\n", i+1, item.Key, item.Data.Title))
		sb.WriteString(fmt.Sprintf("   • Author(s): %s (%s)\n", authors, year))
		if item.Data.PublicationTitle != "" {
			sb.WriteString(fmt.Sprintf("   • Source: %s\n", item.Data.PublicationTitle))
		}
		if item.Data.DOI != "" {
			sb.WriteString(fmt.Sprintf("   • DOI: %s\n", item.Data.DOI))
		}
		if item.Data.Abstract != "" {
			snippet := item.Data.Abstract
			if len(snippet) > 200 {
				snippet = snippet[:200] + "..."
			}
			sb.WriteString(fmt.Sprintf("   • Abstract: %s\n", snippet))
		}
		sb.WriteString("\n")
	}

	return Text(strings.TrimSpace(sb.String()))
}

// -----------------------------------------------------------------------------
// 3. zotero_cite
// -----------------------------------------------------------------------------

type zoteroCiteTool struct{}

func (zoteroCiteTool) Name() string { return "zotero_cite" }
func (zoteroCiteTool) Description() string {
	return "Generate official formatted in-text citations and bibliographic entries for one or more Zotero item keys. Supported citation styles: apa, ieee, harvard, mla, nature, vancouver, chicago-author-date."
}
func (zoteroCiteTool) RequiresApproval() bool { return false }

func (zoteroCiteTool) Schema() map[string]any {
	return schema(map[string]any{
		"item_keys": map[string]any{
			"type":        "array",
			"description": "List of Zotero item keys to cite (e.g. [\"UXDB5SN6\", \"VD586K78\"]).",
			"items":       map[string]any{"type": "string"},
		},
		"style":   propDefault("string", "Citation style: apa, ieee, harvard-cite-them-right, mla, nature, vancouver. Default: apa.", "apa"),
		"user_id": prop("string", "Zotero User ID (optional)."),
		"api_key": prop("string", "Zotero API Key (optional)."),
	}, "item_keys")
}

func (zoteroCiteTool) Execute(ctx context.Context, in Input) Result {
	var args struct {
		ItemKeys []string `json:"item_keys"`
		Style    string   `json:"style"`
		UserID   string   `json:"user_id"`
		APIKey   string   `json:"api_key"`
	}
	if err := in.Bind(&args); err != nil {
		return Errorf("%v", err)
	}

	if len(args.ItemKeys) == 0 {
		return Errorf("item_keys list cannot be empty")
	}

	style := strings.TrimSpace(strings.ToLower(args.Style))
	if style == "" {
		style = "apa"
	}

	userID, apiKey, err := resolveZoteroCreds(in, args.UserID, args.APIKey)
	if err != nil {
		return Errorf("%v", err)
	}

	keysParam := strings.Join(args.ItemKeys, ",")
	reqURL := fmt.Sprintf("%s/users/%s/items?itemKey=%s&include=citation,bib,data&style=%s",
		zoteroAPIBase, url.PathEscape(userID), url.QueryEscape(keysParam), url.QueryEscape(style))

	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return Errorf("create citation request: %v", err)
	}
	req.Header.Set("Zotero-API-Key", apiKey)

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return Errorf("fetch citation: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return Errorf("Zotero API error (%d): %s", resp.StatusCode, string(b))
	}

	var raw []struct {
		Key      string `json:"key"`
		Bib      string `json:"bib"`
		Citation string `json:"citation"`
		Data     struct {
			Title string `json:"title"`
		} `json:"data"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return Errorf("decode citation response: %v", err)
	}

	if len(raw) == 0 {
		return Errorf("no citation data returned for keys %s", keysParam)
	}

	var inTextCitations []string
	var bibliographies []string

	for _, item := range raw {
		cleanCite := stripHTML(item.Citation)
		cleanBib := stripHTML(item.Bib)
		if cleanCite != "" {
			inTextCitations = append(inTextCitations, cleanCite)
		}
		if cleanBib != "" {
			bibliographies = append(bibliographies, cleanBib)
		}
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Citation Results (Style: %s):\n\n", strings.ToUpper(style)))
	sb.WriteString("In-Text Citation(s):\n")
	sb.WriteString(strings.Join(inTextCitations, "; ") + "\n\n")

	sb.WriteString("Bibliography / References:\n")
	for i, bib := range bibliographies {
		sb.WriteString(fmt.Sprintf("[%d] %s\n", i+1, bib))
	}

	return Result{
		Content: strings.TrimSpace(sb.String()),
		Meta: map[string]any{
			"in_text":        strings.Join(inTextCitations, "; "),
			"bibliographies": bibliographies,
			"style":          style,
		},
	}
}
