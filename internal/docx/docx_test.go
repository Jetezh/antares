package docx

import (
	"archive/zip"
	"bytes"
	"io"
	"strings"
	"testing"
)

func TestGenerateDOCX(t *testing.T) {
	title := "Bab 3 - Metodologi Penelitian"
	md := `# Bab 3 - Metodologi Penelitian

## 3.1 Pendekatan Penelitian
Penelitian ini menggunakan pendekatan kuantitatif berbasis eksperimen.

1. Pengumpulan Data Awal
   - Wawancara mendalam
   - Observasi lapangan
2. Implementasi Sistem
   - Modul antarmuka
   - Modul backend

| Komponen | Spesifikasi | Keterangan |
| :--- | :---: | ---: |
| Server | 8 vCPU | Cloud instance |
| Database | PostgreSQL 16 | Distributed |

*Tabel 1: Spesifikasi Lingkungan Pengujian*
`

	b, err := Generate(title, md)
	if err != nil {
		t.Fatalf("Generate failed: %v", err)
	}

	if len(b) == 0 {
		t.Fatal("generated docx is empty")
	}

	// Verify it is a valid zip archive
	zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		t.Fatalf("failed to read generated docx as zip: %v", err)
	}

	files := make(map[string]string)
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("failed to open zip entry %s: %v", f.Name, err)
		}
		data, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatalf("failed to read zip entry %s: %v", f.Name, err)
		}
		files[f.Name] = string(data)
	}

	// Verify required OpenXML structure
	required := []string{
		"[Content_Types].xml",
		"_rels/.rels",
		"word/_rels/document.xml.rels",
		"word/styles.xml",
		"word/document.xml",
	}
	for _, req := range required {
		if _, ok := files[req]; !ok {
			t.Fatalf("missing required docx part: %s", req)
		}
	}

	docXML := files["word/document.xml"]
	if !strings.Contains(docXML, "Bab 3 - Metodologi Penelitian") {
		t.Errorf("document.xml missing heading text")
	}
	if !strings.Contains(docXML, "<w:tbl>") {
		t.Errorf("document.xml missing table element")
	}
	if !strings.Contains(docXML, "Wawancara mendalam") {
		t.Errorf("document.xml missing nested list text")
	}
}
