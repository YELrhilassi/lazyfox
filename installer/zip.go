package main

import (
	"archive/zip"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// buildXPI wraps a directory (dist/extension) into a Firefox-compatible .xpi
// (a plain zip archive). It uses Go's archive/zip deflate so no external
// `zip`/`python3` binary is required — fixing the old shell installers' weak
// dependency on whatever zip tool happened to be installed.
func buildXPI(srcDir, dst string) error {
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()

	zw := zip.NewWriter(out)
	defer zw.Close()

	err = filepath.Walk(srcDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(srcDir, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if info.Name() == ".DS_Store" {
			return nil
		}
		hdr, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		hdr.Name = rel
		hdr.Method = zip.Deflate
		w, err := zw.CreateHeader(hdr)
		if err != nil {
			return err
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = io.Copy(w, f)
		return err
	})
	if err != nil {
		return err
	}
	return nil
}

// readDirFiles returns a sorted list of regular files under dir (no dirs).
func readDirFiles(dir string) ([]string, error) {
	var files []string
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		if strings.HasSuffix(info.Name(), ".DS_Store") {
			return nil
		}
		files = append(files, path)
		return nil
	})
	return files, err
}
