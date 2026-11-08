package main

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

// pluginVersion is reported in the registration metadata and every outbox
// segment so the console can tell which sanitizer produced a record.
const pluginVersion = "1.0.0"

// schemaVersion 10 is CLIProxyAPI v8.0.59's plugin schema. Omitting request
// bodies from frontend authentication requires schema 7 or later.
const schemaVersion = 10

type envelope struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *envelopeError  `json:"error,omitempty"`
}

type envelopeError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type lifecycleRequest struct {
	ConfigYAML []byte `json:"config_yaml"`
}

// Plugin holds the active configuration and outbox. Engine calls arrive from
// several goroutines, so state changes are serialized.
type Plugin struct {
	mu     sync.Mutex
	config Config
	outbox *Outbox
	now    func() time.Time
}

var defaultPlugin = &Plugin{now: time.Now}

// Handle dispatches one ABI method. The boolean reports success to the host.
func (p *Plugin) Handle(method string, request []byte) ([]byte, bool) {
	switch method {
	case "plugin.register", "plugin.reconfigure":
		var req lifecycleRequest
		if err := json.Unmarshal(request, &req); err != nil {
			return errorEnvelope("invalid_request", "lifecycle request is not JSON"), false
		}
		if err := p.configure(req.ConfigYAML); err != nil {
			return errorEnvelope("invalid_config", err.Error()), false
		}
		return okEnvelope(registration()), true
	case "frontend_auth.identifier":
		return okEnvelope(map[string]string{"identifier": pluginID}), true
	case "frontend_auth.authenticate":
		var req authRequest
		if err := json.Unmarshal(request, &req); err != nil {
			return errorEnvelope("invalid_request", "authentication request is not JSON"), false
		}
		return okEnvelope(p.authenticate(req)), true
	case "usage.handle":
		var record usageRecord
		if err := json.Unmarshal(request, &record); err != nil {
			// A malformed record cannot be attributed, but its loss is still counted.
			p.recordUndecodable()
			return okEnvelope(struct{}{}), true
		}
		p.handleUsage(record)
		return okEnvelope(struct{}{}), true
	default:
		return errorEnvelope("unknown_method", "unknown method: "+method), false
	}
}

const pluginID = "cli-proxy-ledger"

func registration() map[string]any {
	return map[string]any{
		"schema_version": schemaVersion,
		"metadata": map[string]any{
			"Name":             pluginID,
			"Version":          pluginVersion,
			"Author":           "cli-proxy",
			"GitHubRepository": "https://github.com/Sumedhbhat/cli-proxy",
			"ConfigFields":     []any{},
		},
		"capabilities": map[string]any{
			"usage_plugin":                     true,
			"frontend_auth_provider":           true,
			"frontend_auth_provider_exclusive": true,
			"frontend_auth_provider_omit_body": true,
		},
	}
}

func (p *Plugin) configure(raw []byte) error {
	config, err := ParseConfig(raw)
	if err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.outbox != nil && p.outbox.dir == config.OutboxDir {
		p.config = config
		return nil
	}
	if p.outbox != nil {
		p.outbox.Close()
		p.outbox = nil
	}
	p.config = config
	if !config.Enabled {
		return nil
	}
	outbox, err := OpenOutbox(config.OutboxDir, p.now)
	if err != nil {
		return fmt.Errorf("open outbox: %w", err)
	}
	p.outbox = outbox
	return nil
}

func (p *Plugin) authenticate(req authRequest) authResponse {
	p.mu.Lock()
	config := p.config
	p.mu.Unlock()
	return Authenticate(config, req)
}

func (p *Plugin) handleUsage(record usageRecord) {
	p.mu.Lock()
	outbox := p.outbox
	p.mu.Unlock()
	if outbox == nil {
		return
	}
	outbox.Append(Sanitize(record, p.now()))
}

func (p *Plugin) recordUndecodable() {
	p.mu.Lock()
	outbox := p.outbox
	p.mu.Unlock()
	if outbox != nil {
		outbox.CountUndecodable()
	}
}

// Shutdown flushes pending records and closes the active segment.
func (p *Plugin) Shutdown() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.outbox != nil {
		p.outbox.Close()
		p.outbox = nil
	}
}

func okEnvelope(result any) []byte {
	raw, err := json.Marshal(result)
	if err != nil {
		return errorEnvelope("encode_failed", err.Error())
	}
	out, _ := json.Marshal(envelope{OK: true, Result: raw})
	return out
}

func errorEnvelope(code, message string) []byte {
	out, _ := json.Marshal(envelope{OK: false, Error: &envelopeError{Code: code, Message: message}})
	return out
}
