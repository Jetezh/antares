package docx

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"regexp"
	"strconv"
	"strings"
)

// Document represents an in-memory Microsoft Word (.docx) document.
type Document struct {
	Title   string
	Content string // Markdown/HTML content
}

// Generate creates a valid .docx ZIP archive as a byte buffer.
func Generate(title, markdownContent string) ([]byte, error) {
	buf := new(bytes.Buffer)
	zw := zip.NewWriter(buf)

	// Collect embedded base64/data-uri images from markdown
	images, cleanedContent := extractEmbeddedImages(markdownContent)

	// 1. [Content_Types].xml
	if err := writeZipFile(zw, "[Content_Types].xml", buildContentTypesXML(len(images))); err != nil {
		return nil, err
	}

	// 2. _rels/.rels
	if err := writeZipFile(zw, "_rels/.rels", buildRootRelsXML()); err != nil {
		return nil, err
	}

	// 3. word/_rels/document.xml.rels
	if err := writeZipFile(zw, "word/_rels/document.xml.rels", buildDocumentRelsXML(len(images))); err != nil {
		return nil, err
	}

	// 4. word/styles.xml
	if err := writeZipFile(zw, "word/styles.xml", buildStylesXML()); err != nil {
		return nil, err
	}

	// 5. word/media/image{N}.png
	for i, imgData := range images {
		imgName := fmt.Sprintf("word/media/image%d.png", i+1)
		if err := writeZipFile(zw, imgName, string(imgData.Bytes)); err != nil {
			return nil, err
		}
	}

	// 6. word/document.xml
	docXML := buildDocumentXML(title, cleanedContent, images)
	if err := writeZipFile(zw, "word/document.xml", docXML); err != nil {
		return nil, err
	}

	if err := zw.Close(); err != nil {
		return nil, err
	}

	return buf.Bytes(), nil
}

type embeddedImage struct {
	ID     string
	RelID  string
	Bytes  []byte
	Width  int64 // EMU (1 pt = 12700 EMU, 1 px = 9525 EMU)
	Height int64
}

var (
	dataURIPattern = regexp.MustCompile(`data:image\/(?:png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=]+)`)
	imgTagPattern  = regexp.MustCompile(`<img\s+[^>]*src=["'](data:image\/[^"']+)["'][^>]*>`)
	mdImgPattern   = regexp.MustCompile(`!\[([^\]]*)\]\((data:image\/[^\)]+)\)`)
)

func extractEmbeddedImages(content string) ([]embeddedImage, string) {
	var images []embeddedImage

	// Replace HTML <img src="data:image/..."> with token __DOCX_IMG_{N}__
	replaced := imgTagPattern.ReplaceAllStringFunc(content, func(m string) string {
		sub := dataURIPattern.FindStringSubmatch(m)
		if len(sub) < 2 {
			return ""
		}
		raw, err := base64.StdEncoding.DecodeString(sub[1])
		if err != nil {
			return ""
		}
		idx := len(images) + 1
		cfg, _, err := image.DecodeConfig(bytes.NewReader(raw))
		wEMU := int64(500 * 9525)
		hEMU := int64(300 * 9525)
		if err == nil && cfg.Width > 0 && cfg.Height > 0 {
			// Cap width at 540 pt (approx 6.8 inches)
			wPt := cfg.Width
			hPt := cfg.Height
			if wPt > 540 {
				hPt = int(float64(hPt) * 540.0 / float64(wPt))
				wPt = 540
			}
			wEMU = int64(wPt) * 9525
			hEMU = int64(hPt) * 9525
		}
		images = append(images, embeddedImage{
			ID:     fmt.Sprintf("img%d", idx),
			RelID:  fmt.Sprintf("rIdImg%d", idx),
			Bytes:  raw,
			Width:  wEMU,
			Height: hEMU,
		})
		return fmt.Sprintf("\n__DOCX_IMG_%d__\n", idx)
	})

	// Replace Markdown ![alt](data:image/...) with token __DOCX_IMG_{N}__
	replaced = mdImgPattern.ReplaceAllStringFunc(replaced, func(m string) string {
		sub := dataURIPattern.FindStringSubmatch(m)
		if len(sub) < 2 {
			return ""
		}
		raw, err := base64.StdEncoding.DecodeString(sub[1])
		if err != nil {
			return ""
		}
		idx := len(images) + 1
		cfg, _, err := image.DecodeConfig(bytes.NewReader(raw))
		wEMU := int64(500 * 9525)
		hEMU := int64(300 * 9525)
		if err == nil && cfg.Width > 0 && cfg.Height > 0 {
			wPt := cfg.Width
			hPt := cfg.Height
			if wPt > 540 {
				hPt = int(float64(hPt) * 540.0 / float64(wPt))
				wPt = 540
			}
			wEMU = int64(wPt) * 9525
			hEMU = int64(hPt) * 9525
		}
		images = append(images, embeddedImage{
			ID:     fmt.Sprintf("img%d", idx),
			RelID:  fmt.Sprintf("rIdImg%d", idx),
			Bytes:  raw,
			Width:  wEMU,
			Height: hEMU,
		})
		return fmt.Sprintf("\n__DOCX_IMG_%d__\n", idx)
	})

	return images, replaced
}

func writeZipFile(zw *zip.Writer, name, content string) error {
	w, err := zw.Create(name)
	if err != nil {
		return err
	}
	_, err = io.WriteString(w, content)
	return err
}

func xmlEscape(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	s = strings.ReplaceAll(s, "\"", "&quot;")
	s = strings.ReplaceAll(s, "'", "&apos;")
	return s
}

func buildContentTypesXML(numImages int) string {
	var sb strings.Builder
	sb.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`)
	return sb.String()
}

func buildRootRelsXML() string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
}

func buildDocumentRelsXML(numImages int) string {
	var sb strings.Builder
	sb.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
`)
	for i := 1; i <= numImages; i++ {
		sb.WriteString(fmt.Sprintf(`  <Relationship Id="rIdImg%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image%d.png"/>`+"\n", i, i))
	}
	sb.WriteString(`</Relationships>`)
	return sb.String()
}

func buildStylesXML() string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>
        <w:sz w:val="24"/>
        <w:szCs w:val="24"/>
        <w:color w:val="000000"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:line="276" w:lineRule="auto" w:before="0" w:after="120"/>
        <w:jc w:val="both"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:pPr>
      <w:spacing w:before="240" w:after="120" w:line="276" w:lineRule="auto"/>
      <w:jc w:val="center"/>
    </w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/>
      <w:b/>
      <w:caps/>
      <w:sz w:val="24"/>
      <w:szCs w:val="24"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:pPr>
      <w:spacing w:before="200" w:after="80" w:line="276" w:lineRule="auto"/>
      <w:jc w:val="left"/>
    </w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/>
      <w:b/>
      <w:sz w:val="24"/>
      <w:szCs w:val="24"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/>
    <w:pPr>
      <w:spacing w:before="160" w:after="60" w:line="276" w:lineRule="auto"/>
      <w:jc w:val="left"/>
    </w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/>
      <w:b/>
      <w:i/>
      <w:sz w:val="24"/>
      <w:szCs w:val="24"/>
    </w:rPr>
  </w:style>
</w:styles>`
}

func buildDocumentXML(title, markdown string, images []embeddedImage) string {
	var body strings.Builder

	lines := strings.Split(strings.ReplaceAll(markdown, "\r\n", "\n"), "\n")

	inTable := false
	var tableRows [][]string

	flushTable := func() {
		if !inTable || len(tableRows) == 0 {
			inTable = false
			tableRows = nil
			return
		}
		body.WriteString(renderTableXML(tableRows))
		inTable = false
		tableRows = nil
	}

	for i := 0; i < len(lines); i++ {
		raw := lines[i]
		trimmed := strings.TrimSpace(raw)

		if trimmed == "" {
			if inTable {
				flushTable()
			}
			continue
		}

		// Table row detection
		if strings.Contains(raw, "|") && i+1 < len(lines) && isTableSep(lines[i+1]) {
			if inTable {
				flushTable()
			}
			inTable = true
			tableRows = append(tableRows, parseTableRow(raw))
			i++ // skip separator line
			for i+1 < len(lines) && strings.Contains(lines[i+1], "|") && strings.TrimSpace(lines[i+1]) != "" {
				i++
				tableRows = append(tableRows, parseTableRow(lines[i]))
			}
			flushTable()
			continue
		}

		if inTable {
			flushTable()
		}

		// Embedded image token: __DOCX_IMG_{N}__
		if strings.HasPrefix(trimmed, "__DOCX_IMG_") && strings.HasSuffix(trimmed, "__") {
			numStr := strings.TrimSuffix(strings.TrimPrefix(trimmed, "__DOCX_IMG_"), "__")
			idx, err := strconv.Atoi(numStr)
			if err == nil && idx > 0 && idx <= len(images) {
				img := images[idx-1]
				body.WriteString(renderImageXML(img))
				continue
			}
		}

		// Headings
		if strings.HasPrefix(trimmed, "# ") {
			text := strings.TrimSpace(strings.TrimPrefix(trimmed, "# "))
			body.WriteString(renderHeadingXML(text, "Heading1"))
			continue
		}
		if strings.HasPrefix(trimmed, "## ") {
			text := strings.TrimSpace(strings.TrimPrefix(trimmed, "## "))
			body.WriteString(renderHeadingXML(text, "Heading2"))
			continue
		}
		if strings.HasPrefix(trimmed, "### ") {
			text := strings.TrimSpace(strings.TrimPrefix(trimmed, "### "))
			body.WriteString(renderHeadingXML(text, "Heading3"))
			continue
		}

		// List Item: bullet / ordered
		listMatch := regexp.MustCompile(`^(\s*)([-*+]|\d+[.)])\s+(.*)$`).FindStringSubmatch(raw)
		if len(listMatch) == 4 {
			indent := len(strings.ReplaceAll(listMatch[1], "\t", "  "))
			level := indent / 2
			isNum := regexp.MustCompile(`\d`).MatchString(listMatch[2])
			marker := listMatch[2]
			if !isNum {
				marker = "•"
			}
			body.WriteString(renderListItemXML(marker, listMatch[3], level))
			continue
		}

		// Caption check: Gambar/Tabel
		isCaption := regexp.MustCompile(`^\*?(Gambar|Figure|Tabel|Table)\s+\d+`).MatchString(trimmed)
		if isCaption {
			body.WriteString(renderCaptionXML(trimmed))
			continue
		}

		// Standard Paragraph (Justified, Indented 8 spaces = ~720 dxa)
		body.WriteString(renderParagraphXML(trimmed, true))
	}

	if inTable {
		flushTable()
	}

	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
            xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    %s
    <w:sectPr>
      <!-- A4 Page size (11906 x 16838 dxa) with 3cm-4cm margins -->
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1701" w:right="1701" w:bottom="1701" w:left="2268"/>
    </w:sectPr>
  </w:body>
</w:document>`, body.String())
}

func isTableSep(s string) bool {
	return regexp.MustCompile(`^\s*\|?[\s:|-]+\|[\s:|-]*$`).MatchString(s)
}

func parseTableRow(s string) []string {
	s = strings.TrimPrefix(strings.TrimSpace(s), "|")
	s = strings.TrimSuffix(s, "|")
	parts := strings.Split(s, "|")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	return parts
}

func renderHeadingXML(text, styleId string) string {
	return fmt.Sprintf(`    <w:p>
      <w:pPr>
        <w:pStyle w:val="%s"/>
      </w:pPr>
      %s
    </w:p>`+"\n", styleId, formatRuns(text, true, false))
}

func renderParagraphXML(text string, indentFirstLine bool) string {
	indentTag := ""
	if indentFirstLine {
		indentTag = `<w:ind w:firstLine="720"/>`
	}
	return fmt.Sprintf(`    <w:p>
      <w:pPr>
        <w:jc w:val="both"/>
        <w:spacing w:line="276" w:lineRule="auto" w:after="100"/>
        %s
      </w:pPr>
      %s
    </w:p>`+"\n", indentTag, formatRuns(text, false, false))
}

func renderCaptionXML(text string) string {
	cleaned := strings.Trim(text, "*_")
	return fmt.Sprintf(`    <w:p>
      <w:pPr>
        <w:jc w:val="center"/>
        <w:spacing w:before="60" w:after="140" w:line="240" w:lineRule="auto"/>
      </w:pPr>
      <w:r>
        <w:rPr>
          <w:i/>
          <w:sz w:val="22"/>
          <w:szCs w:val="22"/>
          <w:color w:val="334155"/>
        </w:rPr>
        <w:t>%s</w:t>
      </w:r>
    </w:p>`+"\n", xmlEscape(cleaned))
}

func renderListItemXML(marker, text string, level int) string {
	leftIndent := 720 + (level * 500)
	hanging := 360
	return fmt.Sprintf(`    <w:p>
      <w:pPr>
        <w:ind w:left="%d" w:hanging="%d"/>
        <w:spacing w:line="276" w:lineRule="auto" w:after="60"/>
        <w:jc w:val="both"/>
      </w:pPr>
      <w:r>
        <w:rPr>
          <w:b/>
        </w:rPr>
        <w:t xml:space="preserve">%s </w:t>
      </w:r>
      %s
    </w:p>`+"\n", leftIndent, hanging, xmlEscape(marker), formatRuns(text, false, false))
}

func renderTableXML(rows [][]string) string {
	if len(rows) == 0 {
		return ""
	}
	var sb strings.Builder
	sb.WriteString(`    <w:tbl>
      <w:tblPr>
        <w:tblW w:w="0" w:type="auto"/>
        <w:jc w:val="center"/>
        <w:tblBorders>
          <w:top w:val="single" w:sz="6" w:space="0" w:color="1E293B"/>
          <w:bottom w:val="single" w:sz="6" w:space="0" w:color="1E293B"/>
          <w:insideH w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/>
          <w:insideV w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/>
          <w:left w:val="single" w:sz="6" w:space="0" w:color="1E293B"/>
          <w:right w:val="single" w:sz="6" w:space="0" w:color="1E293B"/>
        </w:tblBorders>
        <w:tblCellMar>
          <w:top w:w="120" w:type="dxa"/>
          <w:bottom w:w="120" w:type="dxa"/>
          <w:left w:w="160" w:type="dxa"/>
          <w:right w:w="160" w:type="dxa"/>
        </w:tblCellMar>
      </w:tblPr>
`)

	for rIdx, row := range rows {
		isHeader := rIdx == 0
		sb.WriteString("      <w:tr>\n")
		for _, cell := range row {
			bgShade := ""
			align := "left"
			if isHeader {
				bgShade = `<w:shd w:val="clear" w:color="auto" w:fill="F1F5F9"/>`
				align = "center"
			}
			sb.WriteString(fmt.Sprintf(`        <w:tc>
          <w:tcPr>
            %s
            <w:vAlign w:val="center"/>
          </w:tcPr>
          <w:p>
            <w:pPr>
              <w:jc w:val="%s"/>
              <w:spacing w:after="0" w:line="240" w:lineRule="auto"/>
            </w:pPr>
            %s
          </w:p>
        </w:tc>`+"\n", bgShade, align, formatRuns(cell, isHeader, false)))
		}
		sb.WriteString("      </w:tr>\n")
	}

	sb.WriteString("    </w:tbl>\n")
	return sb.String()
}

func renderImageXML(img embeddedImage) string {
	return fmt.Sprintf(`    <w:p>
      <w:pPr>
        <w:jc w:val="center"/>
        <w:spacing w:before="120" w:after="60"/>
      </w:pPr>
      <w:r>
        <w:drawing>
          <wp:inline distT="0" distB="0" distL="0" distR="0">
            <wp:extent cx="%d" cy="%d"/>
            <wp:docPr id="1" name="Figure"/>
            <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
              <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
                  <pic:nvPicPr>
                    <pic:cNvPr id="0" name="Figure"/>
                    <pic:cNvPicPr/>
                  </pic:nvPicPr>
                  <pic:blipFill>
                    <a:blip r:embed="%s"/>
                    <a:stretch>
                      <a:fillRect/>
                    </a:stretch>
                  </pic:blipFill>
                  <pic:spPr>
                    <a:xfrm>
                      <a:off x="0" y="0"/>
                      <a:ext cx="%d" cy="%d"/>
                    </a:xfrm>
                    <a:prstGeom prst="rect">
                      <a:avLst/>
                    </a:prstGeom>
                  </pic:spPr>
                </pic:pic>
              </a:graphicData>
            </a:graphic>
          </wp:inline>
        </w:drawing>
      </w:r>
    </w:p>`+"\n", img.Width, img.Height, img.RelID, img.Width, img.Height)
}

// formatRuns parses basic inline bold/italic/code markdown and emits <w:r> elements
func formatRuns(text string, forceBold, forceItalic bool) string {
	var sb strings.Builder

	// Tokenize bold (**...**) and italic (*...*)
	pattern := regexp.MustCompile(`(\*\*[^*]+\*\*|\*[^*]+\*|` + "`" + `[^` + "`" + `]+` + "`" + `)`)
	parts := pattern.Split(text, -1)
	matches := pattern.FindAllString(text, -1)

	for i := 0; i < len(parts); i++ {
		if parts[i] != "" {
			writeRun(&sb, parts[i], forceBold, forceItalic, false)
		}
		if i < len(matches) {
			m := matches[i]
			if strings.HasPrefix(m, "**") && strings.HasSuffix(m, "**") {
				inner := strings.TrimPrefix(strings.TrimSuffix(m, "**"), "**")
				writeRun(&sb, inner, true, forceItalic, false)
			} else if strings.HasPrefix(m, "*") && strings.HasSuffix(m, "*") {
				inner := strings.TrimPrefix(strings.TrimSuffix(m, "*"), "*")
				writeRun(&sb, inner, forceBold, true, false)
			} else if strings.HasPrefix(m, "`") && strings.HasSuffix(m, "`") {
				inner := strings.TrimPrefix(strings.TrimSuffix(m, "`"), "`")
				writeRun(&sb, inner, forceBold, forceItalic, true)
			}
		}
	}

	return sb.String()
}

func writeRun(sb *strings.Builder, text string, bold, italic, code bool) {
	if text == "" {
		return
	}
	font := "Times New Roman"
	size := "24"
	color := "000000"
	if code {
		font = "Courier New"
		size = "20"
		color = "334155"
	}

	sb.WriteString("      <w:r>\n        <w:rPr>\n")
	sb.WriteString(fmt.Sprintf(`          <w:rFonts w:ascii="%s" w:hAnsi="%s"/>`+"\n", font, font))
	sb.WriteString(fmt.Sprintf(`          <w:sz w:val="%s"/>`+"\n", size))
	sb.WriteString(fmt.Sprintf(`          <w:szCs w:val="%s"/>`+"\n", size))
	if color != "000000" {
		sb.WriteString(fmt.Sprintf(`          <w:color w:val="%s"/>`+"\n", color))
	}
	if bold {
		sb.WriteString("          <w:b/>\n")
	}
	if italic {
		sb.WriteString("          <w:i/>\n")
	}
	sb.WriteString("        </w:rPr>\n")
	sb.WriteString(fmt.Sprintf(`        <w:t xml:space="preserve">%s</w:t>`+"\n", xmlEscape(text)))
	sb.WriteString("      </w:r>\n")
}
