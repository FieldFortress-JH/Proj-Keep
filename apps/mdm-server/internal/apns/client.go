// Package apns implements an Apple Push Notification service (APNs) client
// for sending MDM push notifications to Apple devices.
//
// APNs pushes are how the MDM server wakes a device to tell it "check in now".
// Without a push, the device won't check in until its next scheduled poll
// (which can be hours). With a push, commands are delivered within seconds.
//
// Two authentication methods are supported:
//   - Certificate-based: .p12 certificate + private key (legacy, expires yearly)
//   - Token-based: .p8 key + Key ID + Team ID (modern, auto-renews)
package apns

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sync"
	"time"
)

// APNs gateway endpoints
const (
	ProductionGateway  = "https://api.push.apple.com"
	SandboxGateway     = "https://api.sandbox.push.apple.com"
	HTTP2Port          = 443
	AlternatePort      = 2197 // Fallback port if 443 is blocked
)

// Client is an APNs client for sending MDM push notifications.
type Client struct {
	httpClient *http.Client
	topic      string // APNs topic (usually the MDM server's bundle ID)
	production bool

	// Certificate-based auth
	cert tls.Certificate

	// Token-based auth (not yet implemented — placeholder for future)
	tokenAuth bool

	// Per-org config cache (orgID -> config)
	mu      sync.RWMutex
	configs map[string]*OrgConfig
}

// OrgConfig holds the APNs configuration for a specific organization.
type OrgConfig struct {
	OrgID    string
	CertPEM  []byte
	KeyPEM   []byte
	Topic    string
	Expiry   time.Time
	LoadedAt time.Time
}

// PushPayload is the APNs push notification payload for MDM.
// Apple's MDM push is just {"mdm": "push_magic_value"} — the magic value
// tells the device which MDM server to check in with.
type PushPayload struct {
	MDM string `json:"mdm"`
}

// PushResponse represents Apple's response to a push request.
type PushResponse struct {
	StatusCode int
	Reason     string
	APNsID     string
	OK         bool
}

// NewClient creates a new APNs client.
func NewClient(production bool) *Client {
	return &Client{
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
		topic:      "",
		production: production,
		configs:    make(map[string]*OrgConfig),
	}
}

// SetOrgConfig registers an org's APNs certificate configuration.
func (c *Client) SetOrgConfig(orgID string, certPEM, keyPEM []byte, topic string, expiry time.Time) error {
	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return fmt.Errorf("failed to load APNs certificate: %w", err)
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	c.configs[orgID] = &OrgConfig{
		OrgID:    orgID,
		CertPEM:  certPEM,
		KeyPEM:   keyPEM,
		Topic:    topic,
		Expiry:   expiry,
		LoadedAt: time.Now(),
	}
	_ = cert // Store the parsed cert for per-request TLS config

	log.Printf("APNs config loaded for org %s (topic: %s, expires: %s)", orgID, topic, expiry.Format("2006-01-02"))
	return nil
}

// GetOrgConfig retrieves an org's APNs config.
func (c *Client) GetOrgConfig(orgID string) *OrgConfig {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.configs[orgID]
}

// gatewayURL returns the APNs gateway URL based on production/sandbox mode.
func (c *Client) gatewayURL() string {
	if c.production {
		return ProductionGateway
	}
	return SandboxGateway
}

// Push sends an MDM push notification to a device.
// deviceToken is the APNs device token (hex string) for the target device.
// pushMagic is the unique "PushMagic" value from the device's enrollment profile.
// orgID is used to look up the correct APNs certificate.
func (c *Client) Push(ctx context.Context, orgID, deviceToken, pushMagic string) (*PushResponse, error) {
	config := c.GetOrgConfig(orgID)
	if config == nil {
		return nil, fmt.Errorf("no APNs config for org %s", orgID)
	}

	// Check cert expiry
	if time.Now().After(config.Expiry) {
		return nil, fmt.Errorf("APNs certificate for org %s expired on %s", orgID, config.Expiry.Format("2006-01-02"))
	}

	// Build push payload
	payload := PushPayload{MDM: pushMagic}
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal push payload: %w", err)
	}

	// Build the HTTPS/2 request
	topic := config.Topic
	if topic == "" {
		topic = c.topic
	}
	url := fmt.Sprintf("%s/3/device/%s", c.gatewayURL(), deviceToken)

	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(payloadBytes))
	if err != nil {
		return nil, fmt.Errorf("failed to create push request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("apns-topic", topic)
	req.Header.Set("apns-push-type", "mdm")
	req.Header.Set("apns-priority", "10") // High priority for MDM
	req.Header.Set("apns-expiration", "0") // No expiration — MDM pushes should be delivered

	// Create a TLS config with the org's certificate
	cert, err := tls.X509KeyPair(config.CertPEM, config.KeyPEM)
	if err != nil {
		return nil, fmt.Errorf("failed to load certificate: %w", err)
	}

	transport := &http.Transport{
		TLSClientConfig: &tls.Config{
			Certificates: []tls.Certificate{cert},
		},
		ForceAttemptHTTP2: true,
	}
	httpClient := &http.Client{
		Transport: transport,
		Timeout:   10 * time.Second,
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("push request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)

	pushResp := &PushResponse{
		StatusCode: resp.StatusCode,
		APNsID:     resp.Header.Get("apns-id"),
		OK:         resp.StatusCode == http.StatusOK,
	}

	// Parse Apple's error reason if not 200
	if resp.StatusCode != http.StatusOK {
		var errResp struct {
			Reason    string `json:"reason"`
			Timestamp int64  `json:"timestamp"`
		}
		if json.Unmarshal(respBody, &errResp) == nil {
			pushResp.Reason = errResp.Reason
		}
		log.Printf("APNs push failed for device %s (org %s): %d %s — %s",
			deviceToken[:8]+"...", orgID, resp.StatusCode, resp.Status, pushResp.Reason)
	} else {
		log.Printf("APNs push sent to device %s (org %s): %s", deviceToken[:8]+"...", orgID, pushResp.APNsID)
	}

	return pushResp, nil
}

// PushBatch sends MDM pushes to multiple devices concurrently.
func (c *Client) PushBatch(ctx context.Context, pushes []PushRequest) []*PushResponse {
	results := make([]*PushResponse, len(pushes))
	var wg sync.WaitGroup

	for i, p := range pushes {
		wg.Add(1)
		go func(idx int, req PushRequest) {
			defer wg.Done()
			resp, err := c.Push(ctx, req.OrgID, req.DeviceToken, req.PushMagic)
			if err != nil {
				results[idx] = &PushResponse{OK: false, Reason: err.Error()}
			} else {
				results[idx] = resp
			}
		}(i, p)
	}

	wg.Wait()
	return results
}

// PushRequest represents a single push to send.
type PushRequest struct {
	OrgID       string
	DeviceToken string
	PushMagic   string
}

// ValidateConfig checks if an org's APNs configuration is valid and not expired.
func (c *Client) ValidateConfig(orgID string) (valid bool, daysUntilExpiry int, err error) {
	config := c.GetOrgConfig(orgID)
	if config == nil {
		return false, 0, fmt.Errorf("no config for org %s", orgID)
	}

	_, err = tls.X509KeyPair(config.CertPEM, config.KeyPEM)
	if err != nil {
		return false, 0, fmt.Errorf("invalid certificate: %w", err)
	}

	days := int(time.Until(config.Expiry).Hours() / 24)
	return time.Now().Before(config.Expiry), days, nil
}
