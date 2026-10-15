// Package mdm implements the core MDM engine that wires NanoMDM's protocol
// handlers to our PostgreSQL storage and APNs push client.
//
// This is the heart of the sidecar: it translates between Apple's MDM protocol
// (which devices speak) and Breeze's data model (PostgreSQL + REST API).
package mdm

import (
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/fieldfortress-jh/breeze/mdm-server/internal/apns"
	"github.com/fieldfortress-jh/breeze/mdm-server/internal/storage"
)

// Engine is the MDM protocol engine. It handles device check-ins, command
// queuing, and APNs push dispatch.
type Engine struct {
	storage *storage.DB
	apns    *apns.Client
	// ServerURL is the public URL devices use to reach this MDM server
	// (e.g., "https://mdm.breeze.lan")
	ServerURL string
}

// NewEngine creates a new MDM engine.
func NewEngine(store *storage.DB, apnsClient *apns.Client, serverURL string) *Engine {
	return &Engine{
		storage:   store,
		apns:      apnsClient,
		ServerURL: serverURL,
	}
}

// ─── Apple MDM Protocol Types ───

// MDMRequest is the plist-decoded request from a device.
type MDMRequest struct {
	XMLName     xml.Name `xml:"plist"`
	Version     string   `xml:"version,attr"`
	UDID        string   `xml:"dict>key"` // First key is UDID
	Status      string   // "Idle", "Acknowledged", "Error", "NotNow", "CheckOut"
	CommandUUID string
	RequestType string
}

// mdmPlist is the raw plist structure from a device check-in.
type mdmPlist struct {
	XMLName xml.Name `xml:"plist"`
	Dict    mdmDict  `xml:"dict"`
}

type mdmDict struct {
	Keys   []string          `xml:"key"`
	Values []mdmValue        `xml:"*"`
}

type mdmValue struct {
	XMLName  xml.Name
	Text     string          `xml:",chardata"`
	InnerXML string          `xml:",innerxml"`
}

// ─── Device Check-in Handler ───

// HandleCheckin processes a device check-in (PUT /mdm/mdm).
// This is the most important endpoint — devices call it to:
//   - Report status (Idle = ready for commands)
//   - Acknowledge previously sent commands
//   - Check out (unenroll)
func (e *Engine) HandleCheckin(w http.ResponseWriter, r *http.Request) {
	// Extract device identity from mTLS certificate or header
	udid := extractUDID(r)
	if udid == "" {
		log.Printf("MDM check-in with no UDID — rejecting")
		http.Error(w, "Missing device identity", http.StatusUnauthorized)
		return
	}

	// Read and parse the device's plist request
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read request", http.StatusBadRequest)
		return
	}

	device, err := e.storage.GetDevice(r.Context(), udid)
	if err != nil {
		log.Printf("Error looking up device %s: %v", udid, err)
		http.Error(w, "Database error", http.StatusInternalServerError)
		return
	}

	if device == nil {
		log.Printf("Unknown device check-in: %s — sending enrollment challenge", udid)
		// Device not enrolled — send an enrollment profile redirect
		e.sendAuthChallenge(w, r, udid)
		return
	}

	// Update last check-in
	_ = e.storage.UpdateDeviceCheckin(r.Context(), udid)

	// Parse the MDM status from the request
	status := parseMDMStatus(body)
	log.Printf("Device %s (%s) check-in: status=%s", device.ModelName, udid[:8], status)

	switch status {
	case "CheckOut":
		// Device is unenrolling — mark it
		e.handleCheckOut(r.Context(), device)
		e.sendEmptyResponse(w)

	case "Acknowledged", "Error", "NotNow":
		// Command response — parse and update command status
		e.handleCommandResponse(r.Context(), device, body)
		// After processing response, check for new commands
		e.sendPendingCommands(w, r, device)

	case "Idle":
		// Device is idle — check for pending commands
		e.sendPendingCommands(w, r, device)

	default:
		// Unknown status — send pending commands anyway
		e.sendPendingCommands(w, r, device)
	}
}

// ─── Command Response Handler ───

// HandleCommandResponse processes a device's response at /mdm/connect.
func (e *Engine) HandleCommandResponse(w http.ResponseWriter, r *http.Request) {
	udid := extractUDID(r)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read request", http.StatusBadRequest)
		return
	}

	device, err := e.storage.GetDevice(r.Context(), udid)
	if err != nil || device == nil {
		http.Error(w, "Unknown device", http.StatusUnauthorized)
		return
	}

	_ = e.storage.UpdateDeviceCheckin(r.Context(), udid)
	e.handleCommandResponse(r.Context(), device, body)
	w.WriteHeader(http.StatusOK)
}

// ─── Enrollment Handler ───

// HandleEnroll serves the .mobileconfig enrollment profile.
func (e *Engine) HandleEnroll(w http.ResponseWriter, r *http.Request) {
	orgID := r.URL.Query().Get("org_id")
	token := r.URL.Query().Get("token")
	udid := r.URL.Query().Get("udid")

	log.Printf("Enrollment profile requested: org=%s udid=%s", orgID, udid)

	// Generate the enrollment profile
	profile := e.buildEnrollmentProfile(orgID, udid, token)

	w.Header().Set("Content-Type", "application/x-apple-aspen-config")
	w.Header().Set("Content-Disposition", `attachment; filename="breeze-mdm-enrollment.mobileconfig"`)
	w.WriteHeader(http.StatusOK)
	io.WriteString(w, profile)
}

// buildEnrollmentProfile generates the .mobileconfig XML for device enrollment.
func (e *Engine) buildEnrollmentProfile(orgID, udid, token string) string {
	profileUUID := uuid.New().String()
	pushMagic := uuid.New().String() // Unique push magic for this enrollment

	// TODO: Look up org's APNs topic from mdm_apns_config
	topic := "com.breeze.mdm.push"

	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>PayloadContent</key>
	<array>
		<dict>
			<key>PayloadType</key>
			<string>com.apple.mdm</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
			<key>PayloadIdentifier</key>
			<string>com.breeze.mdm.%s</string>
			<key>PayloadUUID</key>
			<string>%s</string>
			<key>PayloadEnabled</key>
			<true/>
			<key>PayloadDisplayName</key>
			<string>Breeze MDM</string>
			<key>PayloadDescription</key>
			<string>Enrolls this device in Breeze MDM management</string>
			<key>PayloadOrganization</key>
			<string>Breeze</string>
			<key>PayloadRemovalDisallowed</key>
			<true/>
			<key>PayloadScope</key>
			<string>System</string>
			<key>ServerURL</key>
			<string>%s/mdm/mdm</string>
			<key>CheckInURL</key>
			<string>%s/mdm/connect</string>
			<key>CheckOutURL</key>
			<string>%s/mdm/enroll</string>
			<key>AccessRights</key>
			<integer>8191</integer>
			<key>Topic</key>
			<string>%s</string>
			<key>PushMagic</key>
			<string>%s</string>
			<key>EnrollmentMode</key>
			<string>BYOD</string>
		</dict>
	</array>
	<key>PayloadDisplayName</key>
	<string>Breeze MDM Enrollment</string>
	<key>PayloadIdentifier</key>
	<string>com.breeze.mdm.enrollment.%s</string>
	<key>PayloadType</key>
	<string>Configuration</string>
	<key>PayloadUUID</key>
	<string>%s</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
	<key>PayloadRemovalDisallowed</key>
	<true/>
	<key>PayloadScope</key>
	<string>System</string>
	<key>ConsentText</key>
	<dict>
		<key>default</key>
		<string>This device will be enrolled in Breeze MDM management. Your administrator will be able to view device information, install configuration profiles, and send commands (lock, wipe, etc.).</string>
	</dict>
</dict>
</plist>`,
		orgID, profileUUID,
		e.ServerURL, e.ServerURL, e.ServerURL,
		topic, pushMagic,
		orgID, uuid.New().String(),
	)
}

// ─── Internal API (called by Breeze API) ───

// QueueCommand queues an MDM command for a device and sends an APNs push.
func (e *Engine) QueueCommand(ctx context.Context, deviceUDID, commandType string, payload map[string]interface{}) (string, error) {
	// Queue in database
	cmd, err := e.storage.QueueCommand(ctx, deviceUDID, commandType, nil)
	if err != nil {
		return "", fmt.Errorf("failed to queue command: %w", err)
	}

	// Look up device to get org and APNs info
	device, err := e.storage.GetDevice(ctx, deviceUDID)
	if err != nil {
		return "", err
	}

	// Send APNs push to wake the device
	if device.APNsToken != "" && device.PushMagic != "" {
		go func() {
			pushCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_, pushErr := e.apns.Push(pushCtx, device.OrgID, device.APNsToken, device.PushMagic)
			if pushErr != nil {
				log.Printf("APNs push failed for %s: %v", deviceUDID[:8], pushErr)
			}
		}()
	}

	return cmd.CommandUUID, nil
}

// ─── Private Helpers ───

func (e *Engine) sendPendingCommands(w http.ResponseWriter, r *http.Request, device *storage.Device) {
	commands, err := e.storage.GetPendingCommands(r.Context(), device.UDID)
	if err != nil {
		log.Printf("Error getting pending commands: %v", err)
		e.sendEmptyResponse(w)
		return
	}

	if len(commands) == 0 {
		e.sendEmptyResponse(w)
		return
	}

	// Build MDM command response (plist)
	// TODO: Build proper Apple MDM command plist for each pending command
	// For now, send empty (commands will be delivered on next check-in)
	e.sendEmptyResponse(w)
}

func (e *Engine) handleCommandResponse(ctx context.Context, device *storage.Device, body []byte) {
	// Parse the command response plist
	// Extract CommandUUID, Status, and any result/error data
	// Update mdm_commands table
	log.Printf("Command response from %s: %d bytes", device.UDID[:8], len(body))
	// TODO: Full plist parsing and command status update
}

func (e *Engine) handleCheckOut(ctx context.Context, device *storage.Device) {
	log.Printf("Device %s (%s) is checking out (unenrolling)", device.ModelName, device.UDID[:8])
	// TODO: Mark device as unenrolled, clean up profiles
}

func (e *Engine) sendEmptyResponse(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/x-apple-aspen-mdm-checkin")
	w.WriteHeader(http.StatusOK)
	io.WriteString(w, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CommandUUID</key>
	<string></string>
	<key>Command</key>
	<dict/>
</dict>
</plist>`)
}

func (e *Engine) sendAuthChallenge(w http.ResponseWriter, r *http.Request, udid string) {
	// Send a 401 with WWW-Authenticate to trigger device authentication
	// In production, this would be mTLS or SCEP-based auth
	w.Header().Set("Content-Type", "application/x-apple-aspen-mdm-checkin")
	w.Header().Set("WWW-Authenticate", `MDMRelam="com.apple.mdm"`)
	w.WriteHeader(http.StatusUnauthorized)
}

// extractUDID gets the device UDID from the request.
// Priority: mTLS client cert → Mdm-Signature header → query param
func extractUDID(r *http.Request) string {
	// From mTLS client certificate (most secure)
	if r.TLS != nil && len(r.TLS.PeerCertificates) > 0 {
		// Extract UDID from cert subject or SAN
		// TODO: Parse from client cert
	}

	// From header (set by reverse proxy after mTLS termination)
	if udid := r.Header.Get("X-MDM-UDID"); udid != "" {
		return udid
	}
	if udid := r.Header.Get("Mdm-Signature-Udid"); udid != "" {
		return udid
	}

	// From query param (less secure, for testing)
	return r.URL.Query().Get("udid")
}

// parseMDMStatus extracts the Status field from the device's plist request.
func parseMDMStatus(body []byte) string {
	// Quick and dirty XML parsing — look for <key>Status</key><string>VALUE</string>
	bodyStr := string(body)

	// Find Status key
	statusIdx := -1
	for i := 0; i < len(bodyStr)-14; i++ {
		if bodyStr[i:i+14] == "<key>Status</key>" {
			statusIdx = i + 14
			break
		}
	}
	if statusIdx < 0 {
		return "Idle"
	}

	// Find the string value after Status
	rest := bodyStr[statusIdx:]
	strStart := -1
	for i := 0; i < len(rest)-8; i++ {
		if rest[i:i+8] == "<string>" {
			strStart = i + 8
			break
		}
	}
	if strStart < 0 {
		return "Idle"
	}

	rest = rest[strStart:]
	strEnd := -1
	for i := 0; i < len(rest)-9; i++ {
		if rest[i:i+9] == "</string>" {
			strEnd = i
			break
		}
	}
	if strEnd < 0 {
		return "Idle"
	}

	return rest[:strEnd]
}
