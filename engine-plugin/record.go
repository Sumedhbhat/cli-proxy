package main

import (
	"strings"
	"time"
)

// usageRecord mirrors only the pluginapi.UsageRecord fields used for
// accounting. Unlisted fields, including Failure.Body, ResponseHeaders,
// BaseURL, and session IDs, are never decoded and cannot reach the outbox.
type usageRecord struct {
	RequestID            string        `json:"RequestID"`
	TraceID              string        `json:"TraceID"`
	SelectionID          string        `json:"SelectionID"`
	Provider             string        `json:"Provider"`
	ExecutorType         string        `json:"ExecutorType"`
	Model                string        `json:"Model"`
	Alias                string        `json:"Alias"`
	APIKey               string        `json:"APIKey"`
	AccessProvider       string        `json:"AccessProvider"`
	AuthID               string        `json:"AuthID"`
	AuthIndex            string        `json:"AuthIndex"`
	AuthType             string        `json:"AuthType"`
	ReasoningEffort      string        `json:"ReasoningEffort"`
	ServiceTier          string        `json:"ServiceTier"`
	EffectiveServiceTier string        `json:"EffectiveServiceTier"`
	ResponseServiceTier  string        `json:"ResponseServiceTier"`
	ResponseModel        string        `json:"ResponseModel"`
	Generate             bool          `json:"Generate"`
	Stream               bool          `json:"Stream"`
	RequestedAt          time.Time     `json:"RequestedAt"`
	Latency              time.Duration `json:"Latency"`
	TTFT                 time.Duration `json:"TTFT"`
	Failed               bool          `json:"Failed"`
	Failure              struct {
		StatusCode int `json:"StatusCode"`
	} `json:"Failure"`
	Detail usageDetail `json:"Detail"`
}

type usageDetail struct {
	InputTokens         int64 `json:"InputTokens"`
	OutputTokens        int64 `json:"OutputTokens"`
	ReasoningTokens     int64 `json:"ReasoningTokens"`
	CachedTokens        int64 `json:"CachedTokens"`
	CacheReadTokens     int64 `json:"CacheReadTokens"`
	CacheCreationTokens int64 `json:"CacheCreationTokens"`
	TotalTokens         int64 `json:"TotalTokens"`
}

// Event is the outbox's accounting schema, version 1. Token counters are the
// engine's raw fields; the console applies provider semantics at ingestion.
type Event struct {
	Version              int         `json:"v"`
	Type                 string      `json:"type"`
	RecordedAt           string      `json:"recorded_at"`
	ExecutionID          string      `json:"execution_id"`
	TraceID              string      `json:"trace_id,omitempty"`
	SelectionID          string      `json:"selection_id,omitempty"`
	Provider             string      `json:"provider"`
	Executor             string      `json:"executor,omitempty"`
	Model                string      `json:"model,omitempty"`
	Alias                string      `json:"alias,omitempty"`
	ResponseModel        string      `json:"response_model,omitempty"`
	AuthID               string      `json:"auth_id,omitempty"`
	AuthIndex            string      `json:"auth_index,omitempty"`
	AuthType             string      `json:"auth_type,omitempty"`
	Principal            string      `json:"principal"`
	RequestedAt          string      `json:"requested_at,omitempty"`
	LatencyMs            int64       `json:"latency_ms"`
	TTFTMs               int64       `json:"ttft_ms"`
	Stream               bool        `json:"stream"`
	Generate             bool        `json:"generate"`
	Failed               bool        `json:"failed"`
	StatusCode           int         `json:"status_code,omitempty"`
	ReasoningEffort      string      `json:"reasoning_effort,omitempty"`
	ServiceTier          string      `json:"service_tier,omitempty"`
	EffectiveServiceTier string      `json:"effective_service_tier,omitempty"`
	ResponseServiceTier  string      `json:"response_service_tier,omitempty"`
	Tokens               EventTokens `json:"tokens"`
}

type EventTokens struct {
	Input         int64 `json:"input"`
	Output        int64 `json:"output"`
	Reasoning     int64 `json:"reasoning"`
	Cached        int64 `json:"cached"`
	CacheRead     int64 `json:"cache_read"`
	CacheCreation int64 `json:"cache_creation"`
	Total         int64 `json:"total"`
}

// bounded keeps identifiers and labels short; nothing here is free text.
func bounded(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len(value) > limit {
		value = value[:limit]
	}
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, value)
}

// principal reduces the engine's client identity to a device ID or a fixed
// category. A raw key can never pass through: only this plugin's own
// principals are kept.
func principal(apiKey string) string {
	if device, ok := strings.CutPrefix(apiKey, "device:"); ok && deviceIDPattern.MatchString(device) {
		return apiKey
	}
	if apiKey == SharedKeyPrincipal {
		return apiKey
	}
	if apiKey == "" {
		return "anonymous"
	}
	return "other"
}

// Sanitize converts an engine record into the explicit accounting schema.
func Sanitize(record usageRecord, now time.Time) Event {
	requestedAt := ""
	if !record.RequestedAt.IsZero() {
		requestedAt = record.RequestedAt.UTC().Format(time.RFC3339Nano)
	}
	return Event{
		Version:              1,
		Type:                 "usage",
		RecordedAt:           now.UTC().Format(time.RFC3339Nano),
		ExecutionID:          bounded(record.RequestID, 80),
		TraceID:              bounded(record.TraceID, 80),
		SelectionID:          bounded(record.SelectionID, 80),
		Provider:             bounded(strings.ToLower(record.Provider), 40),
		Executor:             bounded(record.ExecutorType, 80),
		Model:                bounded(record.Model, 200),
		Alias:                bounded(record.Alias, 200),
		ResponseModel:        bounded(record.ResponseModel, 200),
		AuthID:               bounded(record.AuthID, 200),
		AuthIndex:            bounded(record.AuthIndex, 80),
		AuthType:             bounded(record.AuthType, 40),
		Principal:            principal(record.APIKey),
		RequestedAt:          requestedAt,
		LatencyMs:            record.Latency.Milliseconds(),
		TTFTMs:               record.TTFT.Milliseconds(),
		Stream:               record.Stream,
		Generate:             record.Generate,
		Failed:               record.Failed,
		StatusCode:           record.Failure.StatusCode,
		ReasoningEffort:      bounded(record.ReasoningEffort, 40),
		ServiceTier:          bounded(record.ServiceTier, 40),
		EffectiveServiceTier: bounded(record.EffectiveServiceTier, 40),
		ResponseServiceTier:  bounded(record.ResponseServiceTier, 40),
		Tokens: EventTokens{
			Input:         record.Detail.InputTokens,
			Output:        record.Detail.OutputTokens,
			Reasoning:     record.Detail.ReasoningTokens,
			Cached:        record.Detail.CachedTokens,
			CacheRead:     record.Detail.CacheReadTokens,
			CacheCreation: record.Detail.CacheCreationTokens,
			Total:         record.Detail.TotalTokens,
		},
	}
}
