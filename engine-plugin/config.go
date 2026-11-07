package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
)

// Config is this plugin's section of engine.yaml under plugins.configs.cli-proxy-ledger.
type Config struct {
	Enabled bool
	// OutboxDir receives append-only usage segments for the console to ingest.
	OutboxDir string
	// DeviceSecret authenticates the gateway's device attribution header.
	DeviceSecret []byte
	// EngineKeyHashes are SHA-256 digests of the gateway's engine API keys.
	// As the exclusive frontend authenticator, the plugin must accept them.
	EngineKeyHashes [][sha256.Size]byte
}

// ParseConfig reads the flat mapping CLIProxyAPI marshals for one plugin.
// Only top-level scalar keys are supported; that is all this plugin uses, and
// it keeps the plugin free of third-party YAML dependencies.
func ParseConfig(raw []byte) (Config, error) {
	values := map[string]string{}
	for number, line := range strings.Split(string(raw), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if line[0] == ' ' || line[0] == '\t' || strings.HasPrefix(trimmed, "- ") {
			return Config{}, fmt.Errorf("config line %d: nested values are not supported", number+1)
		}
		key, value, ok := strings.Cut(trimmed, ":")
		if !ok {
			return Config{}, fmt.Errorf("config line %d: expected key: value", number+1)
		}
		scalar, err := yamlScalar(strings.TrimSpace(value))
		if err != nil {
			return Config{}, fmt.Errorf("config %s: %w", strings.TrimSpace(key), err)
		}
		values[strings.TrimSpace(key)] = scalar
	}
	config := Config{Enabled: values["enabled"] == "true"}
	if !config.Enabled {
		return config, nil
	}
	config.OutboxDir = values["outbox-dir"]
	if config.OutboxDir == "" || !filepath.IsAbs(config.OutboxDir) {
		return Config{}, errors.New("outbox-dir must be an absolute path")
	}
	config.OutboxDir = filepath.Clean(config.OutboxDir)
	secret := values["device-secret"]
	if len(secret) < 32 {
		return Config{}, errors.New("device-secret must be at least 32 characters")
	}
	config.DeviceSecret = []byte(secret)
	for _, encoded := range strings.Split(values["engine-key-sha256"], ",") {
		encoded = strings.TrimSpace(encoded)
		if encoded == "" {
			continue
		}
		decoded, err := hex.DecodeString(encoded)
		if err != nil || len(decoded) != sha256.Size {
			return Config{}, errors.New("engine-key-sha256 must contain SHA-256 hex digests")
		}
		config.EngineKeyHashes = append(config.EngineKeyHashes, [sha256.Size]byte(decoded))
	}
	if len(config.EngineKeyHashes) == 0 {
		return Config{}, errors.New("engine-key-sha256 is required")
	}
	return config, nil
}

func yamlScalar(value string) (string, error) {
	switch {
	case value == "" || value == "~" || value == "null":
		return "", nil
	case strings.HasPrefix(value, `"`):
		return strconv.Unquote(value)
	case strings.HasPrefix(value, "'"):
		if len(value) < 2 || !strings.HasSuffix(value, "'") {
			return "", errors.New("unterminated single-quoted string")
		}
		return strings.ReplaceAll(value[1:len(value)-1], "''", "'"), nil
	case strings.ContainsAny(value[:1], "|>&*!{["):
		return "", errors.New("only plain or quoted scalars are supported")
	default:
		if comment := strings.Index(value, " #"); comment >= 0 {
			value = strings.TrimSpace(value[:comment])
		}
		return value, nil
	}
}
