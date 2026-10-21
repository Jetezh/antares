package tools

import (
	"context"
	"fmt"
	"regexp"
	"strings"
)

var svgBlockRe = regexp.MustCompile(`(?s)<svg[\s\S]*?</svg>`)

func escapeAmpersandsInSVG(svg string) string {
	var b strings.Builder
	for i := 0; i < len(svg); i++ {
		if svg[i] == '&' {
			rest := svg[i:]
			if strings.HasPrefix(rest, "&amp;") ||
				strings.HasPrefix(rest, "&lt;") ||
				strings.HasPrefix(rest, "&gt;") ||
				strings.HasPrefix(rest, "&quot;") ||
				strings.HasPrefix(rest, "&apos;") {
				b.WriteByte('&')
				continue
			}
			b.WriteString("&amp;")
		} else {
			b.WriteByte(svg[i])
		}
	}
	return b.String()
}

func sanitizeDraftContent(s string) string {
	return svgBlockRe.ReplaceAllStringFunc(s, escapeAmpersandsInSVG)
}

// -----------------------------------------------------------------------------
// 1. draft_read
// -----------------------------------------------------------------------------

type draftReadTool struct{}

func (draftReadTool) Name() string { return "draft_read" }
func (draftReadTool) Description() string {
	return "Read the active academic document draft (Artifact) displayed in the user's Split View. Returns the title and current markdown content."
}
func (draftReadTool) RequiresApproval() bool { return false }
func (draftReadTool) Schema() map[string]any {
	return schema(map[string]any{})
}

func (draftReadTool) Execute(ctx context.Context, in Input) Result {
	if in.Deps == nil || in.Deps.Store == nil {
		return Errorf("storage service not available")
	}

	titleKey := "research:draft:title"
	contentKey := "research:draft:content"
	if in.SessionID != "" {
		titleKey = "research:draft:" + in.SessionID + ":title"
		contentKey = "research:draft:" + in.SessionID + ":content"
	}

	title, _ := in.Deps.Store.GetKV(ctx, titleKey)
	if title == "" && in.SessionID == "" {
		title = "Bab 3 - Perancangan Sistem Bilik"
	}
	content, _ := in.Deps.Store.GetKV(ctx, contentKey)

	return Result{
		Content: fmt.Sprintf("Active Draft Title: %s\n\n```markdown\n%s\n```", title, content),
		Meta: map[string]any{
			"title":   title,
			"content": content,
			"length":  len(content),
		},
	}
}

// -----------------------------------------------------------------------------
// 2. draft_update
// -----------------------------------------------------------------------------

type draftUpdateTool struct{}

func (draftUpdateTool) Name() string { return "draft_update" }
func (draftUpdateTool) Description() string {
	return "Write or update the active academic document draft (Artifact) displayed in the user's Split View. Supports full Markdown, structured tables, and SVG diagrams. The user can preview this draft live in their split view and export it to Google Docs with one click."
}
func (draftUpdateTool) RequiresApproval() bool { return false }
func (draftUpdateTool) Schema() map[string]any {
	return schema(map[string]any{
		"content": prop("string", "The Markdown/HTML content to write to the draft document."),
		"title":   prop("string", "Optional title for the document (e.g. 'Bab 3 - Perancangan Sistem Bilik')."),
		"mode":    propEnum("Update mode: 'replace' to overwrite the whole draft, or 'append' to add to the end of the draft. Default: 'replace'.", "replace", "append"),
	}, "content")
}

func (draftUpdateTool) Execute(ctx context.Context, in Input) Result {
	var args struct {
		Content string `json:"content"`
		Title   string `json:"title"`
		Mode    string `json:"mode"`
	}
	if err := in.Bind(&args); err != nil {
		return Errorf("%v", err)
	}

	if in.Deps == nil || in.Deps.Store == nil {
		return Errorf("storage service not available")
	}

	mode := strings.TrimSpace(strings.ToLower(args.Mode))
	if mode == "" {
		mode = "replace"
	}

	titleKey := "research:draft:title"
	contentKey := "research:draft:content"
	if in.SessionID != "" {
		titleKey = "research:draft:" + in.SessionID + ":title"
		contentKey = "research:draft:" + in.SessionID + ":content"
	}

	finalContent := sanitizeDraftContent(args.Content)
	if mode == "append" {
		existing, _ := in.Deps.Store.GetKV(ctx, contentKey)
		if existing != "" {
			finalContent = strings.TrimRight(existing, "\n") + "\n\n" + strings.TrimLeft(finalContent, "\n")
		}
	}

	_ = in.Deps.Store.SetKV(ctx, contentKey, finalContent)

	title := strings.TrimSpace(args.Title)
	if title != "" {
		_ = in.Deps.Store.SetKV(ctx, titleKey, title)
	} else {
		title, _ = in.Deps.Store.GetKV(ctx, titleKey)
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Berhasil memperbarui Draf Naskah di Split View (Judul: %q):\n", title))
	sb.WriteString(fmt.Sprintf("• Mode: %s\n", mode))
	sb.WriteString(fmt.Sprintf("• Panjang isi: %d karakter\n", len(finalContent)))
	sb.WriteString("• Draf ini sekarang langsung tampil di tab 'Draf Naskah' Split View dan siap diekspor ke Google Docs oleh pengguna.")

	return Result{
		Content: sb.String(),
		Meta: map[string]any{
			"status":  "success",
			"title":   title,
			"mode":    mode,
			"length":  len(finalContent),
		},
	}
}
