package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testSecret = "0123456789abcdef0123456789abcdef"

func testConfig(t *testing.T, dir string) Config {
	t.Helper()
	digest := sha256.Sum256([]byte("engine-key"))
	config, err := ParseConfig([]byte("enabled: true\npriority: 100\noutbox-dir: " + dir +
		"\ndevice-secret: '" + testSecret + "'\nengine-key-sha256: " + hex.EncodeToString(digest[:]) + "\n"))
	if err != nil {
		t.Fatal(err)
	}
	return config
}

func readLines(t *testing.T, dir string) []map[string]any {
	t.Helper()
	names, _ := filepath.Glob(filepath.Join(dir, "*.jsonl"))
	var out []map[string]any
	for _, name := range names {
		file, err := os.Open(name)
		if err != nil {
			t.Fatal(err)
		}
		scanner := bufio.NewScanner(file)
		for scanner.Scan() {
			var value map[string]any
			if err := json.Unmarshal(scanner.Bytes(), &value); err != nil {
				t.Fatalf("invalid line %q: %v", scanner.Text(), err)
			}
			out = append(out, value)
		}
		file.Close()
	}
	return out
}

func TestConfigRejectsUnsafeValues(t *testing.T) {
	for _, raw := range []string{
		"enabled: true\noutbox-dir: relative\ndevice-secret: " + testSecret + "\nengine-key-sha256: aa\n",
		"enabled: true\noutbox-dir: /tmp/x\ndevice-secret: short\nengine-key-sha256: aa\n",
		"enabled: true\noutbox-dir: /tmp/x\ndevice-secret: " + testSecret + "\n",
		"enabled: true\nnested:\n  key: value\n",
	} {
		if _, err := ParseConfig([]byte(raw)); err == nil {
			t.Errorf("accepted %q", raw)
		}
	}
	if config, err := ParseConfig([]byte("enabled: false\n")); err != nil || config.Enabled {
		t.Fatalf("disabled config: %+v %v", config, err)
	}
}

func TestAuthenticationAttributesSignedDevicesOnly(t *testing.T) {
	config := testConfig(t, t.TempDir())
	auth := func(headers map[string][]string) authResponse {
		return Authenticate(config, authRequest{Headers: headers})
	}
	if got := auth(map[string][]string{"Authorization": {"Bearer wrong"}}); got.Authenticated || got.DenyStatusCode != 401 {
		t.Fatalf("wrong key accepted: %+v", got)
	}
	if got := auth(map[string][]string{}); got.Authenticated {
		t.Fatalf("missing key accepted: %+v", got)
	}
	if got := auth(map[string][]string{"X-Api-Key": {"engine-key"}}); !got.Authenticated || got.Principal != SharedKeyPrincipal {
		t.Fatalf("shared key: %+v", got)
	}
	signed := "laptop." + DeviceSignature([]byte(testSecret), "laptop")
	got := auth(map[string][]string{"Authorization": {"Bearer engine-key"}, "X-Cli-Proxy-Device": {signed}})
	if !got.Authenticated || got.Principal != "device:laptop" {
		t.Fatalf("signed device: %+v", got)
	}
	for _, forged := range []string{
		"laptop." + DeviceSignature([]byte(testSecret), "phone"),
		"laptop",
		"Laptop." + DeviceSignature([]byte(testSecret), "Laptop"),
		"laptop." + DeviceSignature([]byte("another-secret-another-secret-xx"), "laptop"),
	} {
		got := auth(map[string][]string{"Authorization": {"Bearer engine-key"}, "X-Cli-Proxy-Device": {forged}})
		if got.Authenticated {
			t.Fatalf("forged attribution %q accepted: %+v", forged, got)
		}
	}
	if raw, _ := json.Marshal(got); strings.Contains(string(raw), "engine-key") {
		t.Fatal("authentication result exposes the engine key")
	}
}

func TestSanitizeKeepsAccountingMetadataOnly(t *testing.T) {
	raw := []byte(`{"RequestID":"exec-1","TraceID":"trace","Provider":"Claude","Model":"claude-opus-5-5",
		"APIKey":"sk-live-secret","AuthID":"claude-a.json","Failed":true,
		"Failure":{"StatusCode":429,"Body":"prompt text and error body"},
		"ResponseHeaders":{"Authorization":["Bearer upstream"]},"BaseURL":"https://secret.example",
		"SessionID":"session","Latency":1500000000,"RequestedAt":"2026-11-07T10:00:00Z",
		"Detail":{"InputTokens":10,"OutputTokens":5,"CacheReadTokens":3,"TotalTokens":18}}`)
	var record usageRecord
	if err := json.Unmarshal(raw, &record); err != nil {
		t.Fatal(err)
	}
	event := Sanitize(record, time.Date(2026, 11, 7, 10, 0, 2, 0, time.UTC))
	encoded, _ := json.Marshal(event)
	for _, secret := range []string{"sk-live-secret", "prompt text", "Bearer upstream", "secret.example", "session"} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("event leaks %q: %s", secret, encoded)
		}
	}
	if event.Principal != "other" || event.Provider != "claude" || event.StatusCode != 429 ||
		event.LatencyMs != 1500 || event.Tokens.CacheRead != 3 || event.ExecutionID != "exec-1" {
		t.Fatalf("unexpected event: %+v", event)
	}
	for apiKey, want := range map[string]string{"device:laptop": "device:laptop", "shared-key": "shared-key", "": "anonymous", "device:Bad Id": "other"} {
		if got := principal(apiKey); got != want {
			t.Errorf("principal(%q) = %q, want %q", apiKey, got, want)
		}
	}
}

func TestOutboxPersistsRetriesAndReportsLoss(t *testing.T) {
	dir := t.TempDir()
	clock := time.Date(2026, 11, 7, 10, 0, 0, 0, time.UTC)
	now := func() time.Time { return clock }
	outbox, err := OpenOutbox(dir, now)
	if err != nil {
		t.Fatal(err)
	}
	outbox.Append(Event{Version: 1, Type: "usage", ExecutionID: "a"})

	// Make the disk refuse writes: the event stays pending instead of vanishing.
	outbox.mu.Lock()
	outbox.file.Close()
	outbox.mu.Unlock()
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	outbox.Append(Event{Version: 1, Type: "usage", ExecutionID: "b"})
	if len(outbox.pending) != 1 || outbox.failedWrites == 0 {
		t.Fatalf("failed write was not retained: pending=%d failures=%d", len(outbox.pending), outbox.failedWrites)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	outbox.Append(Event{Version: 1, Type: "usage", ExecutionID: "c"})
	outbox.Close()

	var ids []string
	sawFailure := false
	for _, line := range readLines(t, dir) {
		switch line["type"] {
		case "usage":
			ids = append(ids, line["execution_id"].(string))
		case "write-failures":
			sawFailure = line["failed_writes"].(float64) > 0
		}
	}
	if strings.Join(ids, ",") != "a,b,c" || !sawFailure {
		t.Fatalf("ids=%v failureMarker=%v", ids, sawFailure)
	}
	info, _ := os.Stat(dir)
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("outbox mode %v", info.Mode().Perm())
	}
}

func TestOutboxRotatesSegmentsAtDayBoundary(t *testing.T) {
	dir := t.TempDir()
	clock := time.Date(2026, 11, 7, 23, 59, 0, 0, time.UTC)
	outbox, err := OpenOutbox(dir, func() time.Time { return clock })
	if err != nil {
		t.Fatal(err)
	}
	outbox.Append(Event{Type: "usage", ExecutionID: "a"})
	clock = clock.Add(2 * time.Minute)
	outbox.Append(Event{Type: "usage", ExecutionID: "b"})
	outbox.Close()
	names, _ := filepath.Glob(filepath.Join(dir, "*.jsonl"))
	if len(names) != 2 {
		t.Fatalf("segments: %v", names)
	}
}

func TestLifecycleRegistersExclusiveBodylessAuthentication(t *testing.T) {
	plugin := &Plugin{now: time.Now}
	dir := t.TempDir()
	digest := sha256.Sum256([]byte("engine-key"))
	yaml := "enabled: true\noutbox-dir: " + dir + "\ndevice-secret: " + testSecret + "\nengine-key-sha256: " + hex.EncodeToString(digest[:]) + "\n"
	request, _ := json.Marshal(map[string]any{"config_yaml": []byte(yaml), "schema_version": 10})
	raw, ok := plugin.Handle("plugin.register", request)
	if !ok {
		t.Fatalf("register failed: %s", raw)
	}
	var reply struct {
		Result struct {
			Capabilities map[string]bool `json:"capabilities"`
		} `json:"result"`
	}
	_ = json.Unmarshal(raw, &reply)
	for _, capability := range []string{"usage_plugin", "frontend_auth_provider_exclusive", "frontend_auth_provider_omit_body"} {
		if !reply.Result.Capabilities[capability] {
			t.Fatalf("missing capability %s: %s", capability, raw)
		}
	}
	usage, _ := json.Marshal(map[string]any{"RequestID": "x", "Provider": "codex", "APIKey": "shared-key"})
	if _, ok := plugin.Handle("usage.handle", usage); !ok {
		t.Fatal("usage.handle failed")
	}
	plugin.Shutdown()
	types := []string{}
	for _, line := range readLines(t, dir) {
		types = append(types, line["type"].(string))
	}
	if strings.Join(types, ",") != "segment-start,usage,segment-end" {
		t.Fatalf("segment lines: %v", types)
	}
}
