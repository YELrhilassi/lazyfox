package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"testing"
)

// runHost drives the real read loop over an in-memory stdin/stdout, so a test
// exercises the same framing Firefox does rather than a function beside it.
func runHost(t *testing.T, input []byte) []byte {
	t.Helper()
	var out bytes.Buffer
	h := &Host{
		router:       NewRouter(),
		stdin:        bufio.NewReader(bytes.NewReader(input)),
		stdoutWriter: bufio.NewWriter(&out),
		shutdown:     make(chan struct{}),
	}
	h.registerBuiltinMethods()
	h.readLoop(context.Background())
	return out.Bytes()
}

// frame encodes one native-messaging message: a 32-bit length in native byte
// order, then the JSON bytes, with NO trailing newline.
func frame(payload []byte) []byte {
	var head [4]byte
	binary.NativeEndian.PutUint32(head[:], uint32(len(payload)))
	return append(head[:], payload...)
}

// The bug this pins: the host used to read newline-delimited lines. A real
// Firefox request is a length-prefixed frame with no newline, so the host never
// answered and the extension reported it as missing while every file was
// installed. A framed request must produce a framed reply.
func TestFramedRequestGetsAFramedReply(t *testing.T) {
	req := []byte(`{"jsonrpc":"2.0","id":1,"method":"host.info"}`)
	out := runHost(t, frame(req))

	if len(out) < 4 {
		t.Fatalf("no framed reply: %d bytes", len(out))
	}
	n := binary.NativeEndian.Uint32(out[:4])
	if int(n) != len(out)-4 {
		t.Fatalf("frame length %d does not match %d payload bytes", n, len(out)-4)
	}
	var resp JSONRPCResponse
	if err := json.Unmarshal(out[4:], &resp); err != nil {
		t.Fatalf("reply is not JSON: %v (%q)", err, out[4:])
	}
	result, ok := resp.Result.(map[string]interface{})
	if !ok {
		t.Fatalf("host.info returned %T, want an object", resp.Result)
	}
	if result["name"] != AppName || result["protocol"] != ProtocolVersion {
		t.Fatalf("host.info = %v", result)
	}
}

// Two frames in one stream must both be answered, in order: Firefox sends
// requests back to back, and a reader that consumes the second frame's length
// bytes as part of the first payload would answer garbage.
func TestConsecutiveFramesAreBothAnswered(t *testing.T) {
	in := append(frame([]byte(`{"jsonrpc":"2.0","id":1,"method":"host.ping"}`)),
		frame([]byte(`{"jsonrpc":"2.0","id":2,"method":"host.diag"}`))...)
	out := runHost(t, in)

	var ids []string
	for len(out) > 0 {
		if len(out) < 4 {
			t.Fatalf("truncated frame header: %q", out)
		}
		n := int(binary.NativeEndian.Uint32(out[:4]))
		if len(out) < 4+n {
			t.Fatalf("truncated frame body: want %d, have %d", n, len(out)-4)
		}
		var resp JSONRPCResponse
		if err := json.Unmarshal(out[4:4+n], &resp); err != nil {
			t.Fatalf("frame is not JSON: %v", err)
		}
		ids = append(ids, string(resp.ID))
		out = out[4+n:]
	}
	if len(ids) != 2 || ids[0] != "1" || ids[1] != "2" {
		t.Fatalf("replies = %v, want ids 1 and 2", ids)
	}
}

// A person (or the docs' smoke test) pipes one JSON object per line. That is not
// the native-messaging wire format, but it must keep working, and the reply must
// come back as a line rather than as a frame nobody is looking for.
func TestPipedLineStillGetsALineReply(t *testing.T) {
	out := runHost(t, []byte(`{"jsonrpc":"2.0","id":7,"method":"host.ping"}`+"\n"))
	if len(out) == 0 || out[len(out)-1] != '\n' {
		t.Fatalf("a line request must get a line reply, got %q", out)
	}
	var resp JSONRPCResponse
	if err := json.Unmarshal(bytes.TrimSpace(out), &resp); err != nil {
		t.Fatalf("reply is not JSON: %v", err)
	}
	if string(resp.ID) != "7" {
		t.Fatalf("reply id = %s, want 7", resp.ID)
	}
}

// An absurd length is a corrupt stream, not a reason to allocate 4 GiB.
func TestAnOversizedFrameIsRejected(t *testing.T) {
	var head [4]byte
	binary.NativeEndian.PutUint32(head[:], maxMessageBytes+1)
	out := runHost(t, head[:])
	if len(out) != 0 {
		t.Fatalf("an oversized frame produced a reply: %q", out)
	}
}
