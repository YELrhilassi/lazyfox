//go:build !nogui

package main

import (
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	windowsoptions "github.com/wailsapp/wails/v2/pkg/options/windows"

	"lazyfox/installer/internal/app"
	"lazyfox/installer/internal/config"
	"lazyfox/installer/internal/payload"
)

// frontendAssets is the compiled front-end. `npm run ui:build` produces it into
// frontend/dist and the build scripts run that first, so the installer stays one
// self-contained binary with no sidecar files to ship.
//
//go:embed all:frontend/dist
var frontendAssets embed.FS

// runGUI opens the installer's own native window: Wails hosts the embedded
// front-end in the operating system's webview (WebView2, WKWebView, WebKitGTK)
// and the Go side is the application layer in internal/app.
//
// This is deliberately not a local web server: there is no listener, no port and
// no browser involved. The installer owns its window, so a double-clicked
// download behaves like an installer rather than like a page someone opened.
func runGUI(src *payload.Source, cfg config.Config) error {
	a := app.New(src, cfg)
	return wails.Run(&options.App{
		Title:     "Lazyfox installer",
		Width:     960,
		Height:    780,
		MinWidth:  720,
		MinHeight: 560,

		AssetServer:      &assetserver.Options{Assets: frontendAssets},
		BackgroundColour: &options.RGBA{R: 9, G: 9, B: 11, A: 255},
		OnStartup:        a.Startup,
		OnShutdown:       a.Shutdown,
		Bind:             []interface{}{a},

		Windows: &windowsoptions.Options{
			// Opaque window, no translucency effects: this is an installer, and
			// it should look the same on a machine with effects turned off.
			WebviewIsTransparent: false,
			WindowIsTranslucent:  false,
		},
	})
}
