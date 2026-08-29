// lazyfox-host: Native messaging host for Lazyfox Firefox extension.
// Communicates via JSON-RPC 2.0 over stdio with the extension.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"log"
	"os"
	"os/signal"
	"sync"
	"syscall"
)

const (
	ProtocolVersion = "2.0"
	AppName         = "lazyfox-host"
	Version         = "0.1.0"
)

// JSON-RPC 2.0 structures
type JSONRPCRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type JSONRPCResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  interface{}     `json:"result,omitempty"`
	Error   *JSONRPCError   `json:"error,omitempty"`
}

type JSONRPCError struct {
	Code    int         `json:"code"`
	Message string      `json:"message"`
	Data    interface{} `json:"data,omitempty"`
}

func (e *JSONRPCError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

type JSONRPCNotification struct {
	JSONRPC string          `json:"jsonrpc"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// Handler function signature
type MethodHandler func(ctx context.Context, params json.RawMessage) (interface{}, error)

// Router maps method names to handlers
type Router struct {
	mu       sync.RWMutex
	handlers map[string]MethodHandler
}

func NewRouter() *Router {
	return &Router{handlers: make(map[string]MethodHandler)}
}

func (r *Router) Register(method string, handler MethodHandler) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.handlers[method] = handler
}

func (r *Router) Handle(ctx context.Context, method string, params json.RawMessage) (interface{}, error) {
	r.mu.RLock()
	handler, ok := r.handlers[method]
	r.mu.RUnlock()
	if !ok {
		return nil, &JSONRPCError{Code: -32601, Message: "Method not found: " + method}
	}
	return handler(ctx, params)
}

// Host manages the native messaging host lifecycle
type Host struct {
	router       *Router
	stdinScanner *bufio.Scanner
	stdoutWriter *bufio.Writer
	mu           sync.Mutex
	shutdown     chan struct{}
	wg           sync.WaitGroup
}

func NewHost() *Host {
	h := &Host{
		router:       NewRouter(),
		stdinScanner: bufio.NewScanner(os.Stdin),
		stdoutWriter: bufio.NewWriter(os.Stdout),
		shutdown:     make(chan struct{}),
	}
	h.registerBuiltinMethods()
	return h
}

func (h *Host) registerBuiltinMethods() {
	// System methods
	h.router.Register("host.info", h.handleInfo)
	h.router.Register("host.ping", h.handlePing)
}

func (h *Host) handleInfo(ctx context.Context, params json.RawMessage) (interface{}, error) {
	return map[string]interface{}{
		"name":    AppName,
		"version": Version,
		"protocol": ProtocolVersion,
	}, nil
}

func (h *Host) handlePing(ctx context.Context, params json.RawMessage) (interface{}, error) {
	return map[string]string{"status": "ok"}, nil
}

// RegisterMethod registers a new method handler
func (h *Host) RegisterMethod(method string, handler MethodHandler) {
	h.router.Register(method, handler)
}

// Run starts the host event loop
func (h *Host) Run(ctx context.Context) error {
	// Start reading stdin
	h.wg.Add(1)
	go h.readLoop(ctx)

	// Wait for shutdown
	<-h.shutdown
	h.wg.Wait()
	return nil
}

func (h *Host) readLoop(ctx context.Context) {
	defer h.wg.Done()
	for h.stdinScanner.Scan() {
		select {
		case <-ctx.Done():
			return
		default:
		}

		line := h.stdinScanner.Text()
		if line == "" {
			continue
		}

		var req JSONRPCRequest
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			h.sendError(nil, -32700, "Parse error: "+err.Error())
			continue
		}

		if req.JSONRPC != ProtocolVersion {
			h.sendError(req.ID, -32600, "Invalid JSON-RPC version")
			continue
		}

		// Check if it's a notification (no ID)
		isNotification := len(req.ID) == 0

		if isNotification {
			// Notifications don't expect a response
			go h.handleNotification(req.Method, req.Params)
		} else {
			// Request expects a response
			go h.handleRequest(req.ID, req.Method, req.Params)
		}
	}

	if err := h.stdinScanner.Err(); err != nil {
		log.Printf("stdin scanner error: %v", err)
	}
	// Stdin closed (EOF) - signal shutdown
	close(h.shutdown)
}

func (h *Host) handleNotification(method string, params json.RawMessage) {
	// Notifications don't expect responses
	// But we can still process them if needed
	_, _ = h.router.Handle(context.Background(), method, params)
}

func (h *Host) handleRequest(id json.RawMessage, method string, params json.RawMessage) {
	result, err := h.router.Handle(context.Background(), method, params)

	var resp JSONRPCResponse
	resp.JSONRPC = ProtocolVersion
	resp.ID = id
	if err != nil {
		resp.Error = &JSONRPCError{Code: -32603, Message: err.Error()}
	} else {
		resp.Result = result
	}

	_ = h.sendResponse(&resp)
}

func (h *Host) sendResponse(resp *JSONRPCResponse) error {
	data, err := json.Marshal(resp)
	if err != nil {
		return err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	_, err = h.stdoutWriter.WriteString(string(data) + "\n")
	if err != nil {
		return err
	}
	return h.stdoutWriter.Flush()
}

func (h *Host) sendError(id json.RawMessage, code int, message string) error {
	resp := JSONRPCResponse{
		JSONRPC: ProtocolVersion,
		ID:      id,
		Error:   &JSONRPCError{Code: code, Message: message},
	}
	return h.sendResponse(&resp)
}

func (h *Host) sendNotification(method string, params interface{}) error {
	data, err := json.Marshal(params)
	if err != nil {
		return err
	}
	notif := JSONRPCNotification{
		JSONRPC: ProtocolVersion,
		Method:  method,
		Params:  data,
	}
	data, err = json.Marshal(notif)
	if err != nil {
		return err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	_, err = h.stdoutWriter.WriteString(string(data) + "\n")
	if err != nil {
		return err
	}
	return h.stdoutWriter.Flush()
}

func main() {
	log.SetFlags(0)
	log.SetOutput(os.Stderr)

	ctx, cancel := context.WithCancel(context.Background())

	// Handle shutdown signals
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigChan
		cancel()
	}()

	host := NewHost()

	// Register all methods
	registerAllMethods(host)

	log.Printf("%s v%s started", AppName, Version)

	if err := host.Run(ctx); err != nil {
		log.Fatalf("Host error: %v", err)
	}

	log.Printf("%s stopped", AppName)
}

// registerAllMethods registers all method handlers
func registerAllMethods(h *Host) {
	// Session management
	h.RegisterMethod("session.list", handleSessionList)
	h.RegisterMethod("session.save", handleSessionSave)
	h.RegisterMethod("session.load", handleSessionLoad)
	h.RegisterMethod("session.delete", handleSessionDelete)
	h.RegisterMethod("session.marker", handleSessionMarker)
	h.RegisterMethod("session.switch_marker", handleSessionSwitchMarker)

	// Tab operations
	h.RegisterMethod("tabs.list", handleTabsList)
	h.RegisterMethod("tabs.activate", handleTabsActivate)
	h.RegisterMethod("tabs.close", handleTabsClose)
	h.RegisterMethod("tabs.move", handleTabsMove)
	h.RegisterMethod("tabs.pin", handleTabsPin)
	h.RegisterMethod("tabs.mute", handleTabsMute)
	h.RegisterMethod("tabs.duplicate", handleTabsDuplicate)
	h.RegisterMethod("tabs.new", handleTabsNew)

	// Split view
	h.RegisterMethod("split.horizontal", handleSplitHorizontal)
	h.RegisterMethod("split.vertical", handleSplitVertical)
	h.RegisterMethod("split.unsplit", handleSplitUnsplit)
	h.RegisterMethod("split.switch_pane", handleSplitSwitchPane)
	h.RegisterMethod("split.swap_panes", handleSplitSwapPanes)
	h.RegisterMethod("split.move_tab_to_split", handleSplitMoveTabToSplit)
	h.RegisterMethod("split.restore_splits", handleSplitRestoreSplits)

	// Window management
	h.RegisterMethod("window.resize", handleWindowResize)
	h.RegisterMethod("window.move", handleWindowMove)

	// History
	h.RegisterMethod("history.list", handleHistoryList)
	h.RegisterMethod("history.remove", handleHistoryRemove)
	h.RegisterMethod("history.clear", handleHistoryClear)

	// Recently closed
	h.RegisterMethod("recently_closed.list", handleRecentlyClosedList)
	h.RegisterMethod("recently_closed.restore", handleRecentlyClosedRestore)
	h.RegisterMethod("recently_closed.restore_all", handleRecentlyClosedRestoreAll)

	// Bookmarks
	h.RegisterMethod("bookmarks.list", handleBookmarksList)

	// Downloads
	h.RegisterMethod("downloads.list", handleDownloadsList)
	h.RegisterMethod("downloads.open", handleDownloadsOpen)
	h.RegisterMethod("downloads.open_location", handleDownloadsOpenLocation)
	h.RegisterMethod("downloads.remove", handleDownloadsRemove)

	// Search / URL
	h.RegisterMethod("search.suggest", handleSearchSuggest)
	h.RegisterMethod("search.open", handleSearchOpen)
	h.RegisterMethod("url.suggest", handleURLSuggest)
	h.RegisterMethod("url.open", handleURLOpen)

	// Leader key / Typing
	h.RegisterMethod("keys.dispatch", handleKeysDispatch)
	h.RegisterMethod("leader.arm", handleLeaderArm)
	h.RegisterMethod("leader.disarm", handleLeaderDisarm)

	// Config
	h.RegisterMethod("config.get", handleConfigGet)
	h.RegisterMethod("config.set", handleConfigSet)

	// Find in page
	h.RegisterMethod("find.search", handleFindSearch)
	h.RegisterMethod("find.next", handleFindNext)
	h.RegisterMethod("find.previous", handleFindPrevious)
	h.RegisterMethod("find.yank", handleFindYank)

	// Debug
	h.RegisterMethod("debug.reveal", handleDebugReveal)
	h.RegisterMethod("debug.console", handleDebugConsole)
	h.RegisterMethod("debug.diag", handleDebugDiag)
}

// Session state is managed by the extension; the native host relays
// requests via native message so the extension can use browser.* APIs.
func handleSessionList(ctx context.Context, params json.RawMessage) (interface{}, error) {
	return nil, nil
}
func handleSessionSave(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleSessionLoad(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleSessionDelete(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleSessionMarker(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleSessionSwitchMarker(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }

func handleTabsList(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleTabsActivate(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleTabsClose(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleTabsMove(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleTabsPin(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleTabsMute(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleTabsDuplicate(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleTabsNew(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }

func handleSplitHorizontal(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleSplitVertical(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleSplitUnsplit(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleSplitSwitchPane(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleSplitSwapPanes(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleSplitMoveTabToSplit(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleSplitRestoreSplits(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }

func handleWindowResize(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleWindowMove(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }

func handleHistoryList(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleHistoryRemove(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleHistoryClear(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }

func handleRecentlyClosedList(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleRecentlyClosedRestore(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleRecentlyClosedRestoreAll(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }

func handleBookmarksList(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }

func handleDownloadsList(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleDownloadsOpen(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleDownloadsOpenLocation(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleDownloadsRemove(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }

func handleSearchSuggest(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleSearchOpen(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleURLSuggest(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleURLOpen(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }

func handleKeysDispatch(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleLeaderArm(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleLeaderDisarm(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }

func handleConfigGet(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleConfigSet(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }

func handleFindSearch(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleFindNext(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleFindPrevious(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleFindYank(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }

func handleDebugReveal(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleDebugConsole(ctx context.Context, params json.RawMessage) (interface{}, error) { return nil, nil }
func handleDebugDiag(ctx context.Context, params json.RawMessage) (interface{}, error) {
	return map[string]interface{}{"host": "lazyfox-host", "version": Version}, nil
}