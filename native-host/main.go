// lazyfox-host: Native messaging host for the Lazyfox extension.
// Communicates via JSON-RPC 2.0 over stdio with the extension
// (browser.runtime.connectNative("lazyfox")).
//
// Scope (see docs/MESSAGING.md): the host owns ONLY what an external process
// can do — health/diagnostics and system-level operations the extension
// cannot reach (synthetic input, window management beyond browser.windows,
// file/path helpers outside the profile). Tab/session/history/etc. are the
// extension's browser.* APIs and deliberately do NOT appear here: the
// extension reaches those itself, so stubs for them would be dead code.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"log"
	"os"
	"os/signal"
	"runtime"
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
}

// Native messaging is low-volume (health checks + the occasional system op),
// so requests are handled synchronously on the read loop: a reply is always
// flushed before the next line is read, and EOF cannot race an in-flight
// handler out of existence (the piped test case would otherwise exit with the
// response half-written).

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
	h.router.Register("host.info", h.handleInfo)
	h.router.Register("host.ping", h.handlePing)
	h.router.Register("host.diag", h.handleDiag)
}

func (h *Host) handleInfo(ctx context.Context, params json.RawMessage) (interface{}, error) {
	return map[string]interface{}{
		"name":     AppName,
		"version":  Version,
		"protocol": ProtocolVersion,
	}, nil
}

func (h *Host) handlePing(ctx context.Context, params json.RawMessage) (interface{}, error) {
	return map[string]string{"status": "ok"}, nil
}

func (h *Host) handleDiag(ctx context.Context, params json.RawMessage) (interface{}, error) {
	return map[string]interface{}{
		"host":    AppName,
		"version": Version,
		"pid":     os.Getpid(),
		"goos":    runtime.GOOS,
		"arch":    runtime.GOARCH,
	}, nil
}

// Run starts the host event loop
func (h *Host) Run(ctx context.Context) error {
	h.readLoop(ctx)
	return nil
}

func (h *Host) readLoop(ctx context.Context) {
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

		// Notifications (no ID) don't expect a response.
		if len(req.ID) == 0 {
			continue
		}
		h.handleRequest(req.ID, req.Method, req.Params)
	}

	if err := h.stdinScanner.Err(); err != nil {
		log.Printf("stdin scanner error: %v", err)
	}
	// Stdin closed (EOF) - signal shutdown
	close(h.shutdown)
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

	log.Printf("%s v%s started", AppName, Version)

	if err := host.Run(ctx); err != nil {
		log.Fatalf("Host error: %v", err)
	}

	log.Printf("%s stopped", AppName)
}
