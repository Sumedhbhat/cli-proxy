package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"regexp"
	"strings"
)

// DeviceHeader carries the gateway's signed device attribution. The gateway
// overwrites any client-supplied value, so only the gateway can produce it.
const DeviceHeader = "X-Cli-Proxy-Device"

var deviceIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,39}$`)

// SharedKeyPrincipal marks requests authenticated by the gateway's engine key
// without a device attribution, for example model catalog lookups.
const SharedKeyPrincipal = "shared-key"

type authRequest struct {
	Headers map[string][]string `json:"Headers"`
}

type authResponse struct {
	Authenticated  bool              `json:"Authenticated"`
	Principal      string            `json:"Principal,omitempty"`
	Metadata       map[string]string `json:"Metadata,omitempty"`
	DenyStatusCode int               `json:"DenyStatusCode,omitempty"`
	DenyMessage    string            `json:"DenyMessage,omitempty"`
}

// DeviceSignature binds a device ID to the secret shared by gateway and plugin.
func DeviceSignature(secret []byte, deviceID string) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte("cli-proxy-device:v1:" + deviceID))
	return hex.EncodeToString(mac.Sum(nil))
}

func header(headers map[string][]string, name string) string {
	for key, values := range headers {
		if strings.EqualFold(key, name) && len(values) > 0 {
			return strings.TrimSpace(values[0])
		}
	}
	return ""
}

func deny(message string) authResponse {
	return authResponse{DenyStatusCode: 401, DenyMessage: message}
}

// Authenticate replaces the engine's native key check while this plugin is
// loaded. It accepts only the configured engine keys and never returns a key.
func Authenticate(config Config, req authRequest) authResponse {
	if !config.Enabled {
		return authResponse{}
	}
	key := header(req.Headers, "X-Api-Key")
	if bearer, ok := strings.CutPrefix(header(req.Headers, "Authorization"), "Bearer "); ok {
		key = strings.TrimSpace(bearer)
	}
	if key == "" {
		return deny("Missing API key")
	}
	digest := sha256.Sum256([]byte(key))
	known := 0
	for _, expected := range config.EngineKeyHashes {
		known |= subtle.ConstantTimeCompare(digest[:], expected[:])
	}
	if known != 1 {
		return deny("Invalid API key")
	}
	attribution := header(req.Headers, DeviceHeader)
	if attribution == "" {
		return authResponse{Authenticated: true, Principal: SharedKeyPrincipal}
	}
	deviceID, signature, ok := strings.Cut(attribution, ".")
	if !ok || !deviceIDPattern.MatchString(deviceID) ||
		!hmac.Equal([]byte(signature), []byte(DeviceSignature(config.DeviceSecret, deviceID))) {
		// A wrong signature means gateway and engine disagree on the secret.
		// Refusing is safer than recording the usage under the wrong device.
		return deny("Invalid device attribution")
	}
	return authResponse{
		Authenticated: true,
		Principal:     "device:" + deviceID,
		Metadata:      map[string]string{"device": deviceID},
	}
}
