// Package mdm implements the core MDM engine that wires the Apple MDM protocol
// handlers to our PostgreSQL storage and APNs push client.
//
// This is the heart of the sidecar: it translates between Apple's MDM protocol
// (which devices speak) and Breeze's data model (PostgreSQL + REST API).
package mdm

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
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
	Keys   []string   `xml:"key"`
	Values []mdmValue `xml:"*"`
}

type mdmValue struct {
	XMLName  xml.Name
	Text     string `xml:",chardata"`
	InnerXML string `xml:",innerxml"`
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
	log.Printf("Device %s (%s) check-in: status=%s", device.ModelName, safeUDID(udid), status)

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

	// Look up org's APNs topic from mdm_apns_config
	topic := e.lookupAPNsTopic(orgID)

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

// lookupAPNsTopic queries the org's APNs topic from the database.
// Falls back to a default if no config exists.
func (e *Engine) lookupAPNsTopic(orgID string) string {
	if orgID == "" {
		return "com.breeze.mdm.push"
	}
	config, err := e.storage.GetAPNsConfig(context.Background(), orgID)
	if err != nil || config == nil || config.Topic == "" {
		return "com.breeze.mdm.push" // Default fallback
	}
	return config.Topic
}

// ─── Internal API (called by Breeze API) ───

// QueueCommand queues an MDM command for a device and sends an APNs push.
func (e *Engine) QueueCommand(ctx context.Context, deviceUDID, commandType string, payload map[string]interface{}) (string, error) {
	// Serialize payload for storage
	var payloadJSON json.RawMessage
	if payload != nil {
		b, _ := json.Marshal(payload)
		payloadJSON = b
	}

	// Queue in database
	cmd, err := e.storage.QueueCommand(ctx, deviceUDID, commandType, payloadJSON)
	if err != nil {
		return "", fmt.Errorf("failed to queue command: %w", err)
	}

	// Look up device to get org and APNs info
	device, err := e.storage.GetDevice(ctx, deviceUDID)
	if err != nil {
		return "", err
	}
	if device == nil {
		return "", fmt.Errorf("device not found: %s", deviceUDID)
	}

	// Send APNs push to wake the device (async)
	if device.APNsToken != "" && device.PushMagic != "" {
		go func() {
			pushCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_, pushErr := e.apns.Push(pushCtx, device.OrgID, device.APNsToken, device.PushMagic)
			if pushErr != nil {
				log.Printf("APNs push failed for %s: %v", safeUDID(deviceUDID), pushErr)
			}
		}()
	} else {
		log.Printf("Device %s has no APNs token — command queued but no push sent", safeUDID(deviceUDID))
	}

	return cmd.CommandUUID, nil
}

// ─── Pending Command Delivery ───

// sendPendingCommands checks for queued commands and delivers them to the device
// as an Apple MDM command plist. If no commands are pending, sends an empty response.
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

	// Deliver the first pending command (Apple MDM sends one at a time)
	cmd := commands[0]
	commandPlist := buildCommandPlist(cmd)

	// Mark as sent
	_ = e.storage.UpdateCommandStatus(r.Context(), cmd.CommandUUID, "sent", nil, "")

	w.Header().Set("Content-Type", "application/x-apple-aspen-mdm-checkin")
	w.WriteHeader(http.StatusOK)
	io.WriteString(w, commandPlist)

	log.Printf("Delivered command %s (%s) to device %s", cmd.CommandUUID, cmd.Type, safeUDID(device.UDID))
}

// buildCommandPlist generates an Apple MDM command plist for a queued command.
// This produces the XML response that the device parses to execute the command.
func buildCommandPlist(cmd *storage.Command) string {
	commandName := commandTypeToApple(cmd.Type)
	payloadXML := buildCommandPayloadXML(cmd)

	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CommandUUID</key>
	<string>%s</string>
	<key>Command</key>
	<dict>
		<key>RequestType</key>
		<string>%s</string>
%s
	</dict>
</dict>
</plist>`,
		cmd.CommandUUID,
		commandName,
		payloadXML,
	)
}

// commandTypeToApple maps our internal command types to Apple's RequestType values.
func commandTypeToApple(cmdType string) string {
	switch cmdType {
	case "install_profile":
		return "InstallProfile"
	case "remove_profile":
		return "RemoveProfile"
	case "device_lock":
		return "DeviceLock"
	case "device_wipe":
		return "EraseDevice"
	case "clear_passcode":
		return "ClearPasscode"
	case "restart_device":
		return "RestartDevice"
	case "shutdown_device":
		return "ShutDownDevice"
	case "os_update":
		return "OSUpdate"
	case "install_app":
		return "InstallApplication"
	case "remove_app":
		return "RemoveApplication"
	case "device_information":
		return "DeviceInformation"
	case "profile_list":
		return "ProfileList"
	case "security_info":
		return "SecurityInfo"
	case "certificate_list":
		return "CertificateList"
	default:
		return "DeviceInformation" // Safe default
	}
}

// buildCommandPayloadXML generates the command-specific payload XML.
// Each Apple command type has its own required/optional keys.
func buildCommandPayloadXML(cmd *storage.Command) string {
	switch cmd.Type {
	case "install_profile":
		// InstallProfile requires Payload key with base64-encoded .mobileconfig
		payloadB64 := ""
		if cmd.Payload != nil {
			var p struct {
				ProfileData string `json:"profileData"` // base64-encoded .mobileconfig
			}
			if json.Unmarshal(cmd.Payload, &p) == nil && p.ProfileData != "" {
				payloadB64 = p.ProfileData
			}
		}
		if payloadB64 != "" {
			return fmt.Sprintf(`		<key>Payload</key>
		<data>%s</data>`, payloadB64)
		}
		// Fallback: try to read profile_payload from mdm_profiles
		return `		<key>Payload</key>
		<data></data>`

	case "remove_profile":
		// RemoveProfile requires Identifier key
		identifier := ""
		if cmd.Payload != nil {
			var p struct {
				Identifier string `json:"identifier"`
			}
			if json.Unmarshal(cmd.Payload, &p) == nil {
				identifier = p.Identifier
			}
		}
		return fmt.Sprintf(`		<key>Identifier</key>
		<string>%s</string>`, escapeXML(identifier))

	case "device_lock":
		// DeviceLock can include a message and phone number
		message := ""
		phoneNumber := ""
		if cmd.Payload != nil {
			var p struct {
				Message     string `json:"message"`
				PhoneNumber string `json:"phoneNumber"`
			}
			if json.Unmarshal(cmd.Payload, &p) == nil {
				message = p.Message
				phoneNumber = p.PhoneNumber
			}
		}
		xml := ""
		if message != "" {
			xml += fmt.Sprintf(`		<key>Message</key>
		<string>%s</string>`, escapeXML(message))
		}
		if phoneNumber != "" {
			if xml != "" {
				xml += "\n"
			}
			xml += fmt.Sprintf(`		<key>PhoneNumber</key>
		<string>%s</string>`, escapeXML(phoneNumber))
		}
		return xml

	case "device_wipe":
		// EraseDevice can include a PIN (for supervised devices with Activation Lock bypass)
		pin := ""
		if cmd.Payload != nil {
			var p struct {
				PIN string `json:"pin"`
			}
			if json.Unmarshal(cmd.Payload, &p) == nil {
				pin = p.PIN
			}
		}
		if pin != "" {
			return fmt.Sprintf(`		<key>PIN</key>
		<string>%s</string>`, escapeXML(pin))
		}
		return ""

	case "os_update":
		// OSUpdate can enforce a specific version
		productVersion := ""
		if cmd.Payload != nil {
			var p struct {
				ProductVersion string `json:"productVersion"`
			}
			if json.Unmarshal(cmd.Payload, &p) == nil {
				productVersion = p.ProductVersion
			}
		}
		if productVersion != "" {
			return fmt.Sprintf(`		<key>ProductVersion</key>
		<string>%s</string>`, escapeXML(productVersion))
		}
		return ""

	case "device_information", "profile_list", "security_info", "certificate_list":
		// These query commands accept an optional Queries array
		queries := []string{"UDID", "DeviceName", "OSVersion", "ModelName", "SerialNumber"}
		if cmd.Payload != nil {
			var p struct {
				Queries []string `json:"queries"`
			}
			if json.Unmarshal(cmd.Payload, &p) == nil && len(p.Queries) > 0 {
				queries = p.Queries
			}
		}
		queryItems := ""
		for _, q := range queries {
			queryItems += fmt.Sprintf("			<string>%s</string>", escapeXML(q))
		}
		return fmt.Sprintf(`		<key>QueryResponses</key>
		<array>%s
		</array>`, queryItems)

	default:
		// Generic: emit any payload keys as-is
		if cmd.Payload != nil {
			var p map[string]interface{}
			if json.Unmarshal(cmd.Payload, &p) == nil {
				var lines []string
				for k, v := range p {
					switch val := v.(type) {
					case string:
						lines = append(lines, fmt.Sprintf("		<key>%s</key>\n		<string>%s</string>", escapeXML(k), escapeXML(val)))
					case float64:
						lines = append(lines, fmt.Sprintf("		<key>%s</key>\n		<integer>%d</integer>", escapeXML(k), int64(val)))
					case bool:
						lines = append(lines, fmt.Sprintf("		<key>%s</key>\n		<%s/>", escapeXML(k), map[bool]string{true: "true", false: "false"}[val]))
					}
				}
				if len(lines) > 0 {
					return strings.Join(lines, "\n")
				}
			}
		}
		return ""
	}
}

// ─── Command Response Processing ───

// handleCommandResponse parses a device's command response plist and updates
// the command status in the database.
//
// A device response looks like:
// <?xml version="1.0"?>
// <plist version="1.0">
// <dict>
//   <key>CommandUUID</key><string>xxx</string>
//   <key>Status</key><string>Acknowledged|Error|NotNow</string>
//   <key>UDID</key><string>yyy</string>
//   <!-- For query commands, additional result keys -->
// </dict>
// </plist>
func (e *Engine) handleCommandResponse(ctx context.Context, device *storage.Device, body []byte) {
	bodyStr := string(body)
	log.Printf("Command response from %s: %d bytes", safeUDID(device.UDID), len(body))

	// Extract CommandUUID
	commandUUID := extractPlistString(bodyStr, "CommandUUID")
	if commandUUID == "" {
		log.Printf("Command response with no CommandUUID — ignoring")
		return
	}

	// Extract Status
	status := extractPlistString(bodyStr, "Status")
	var newStatus string
	var errorCode string

	switch status {
	case "Acknowledged":
		newStatus = "acknowledged"
	case "Error":
		newStatus = "error"
		errorCode = extractPlistString(bodyStr, "ErrorCode")
		if errorCode == "" {
			// Try to get the error chain
			if chain := extractPlistString(bodyStr, "ErrorChain"); chain != "" {
				errorCode = chain
			}
		}
	case "NotNow":
		// Device will retry later — keep as sent, don't change status
		log.Printf("Device %s returned NotNow for command %s — will retry", safeUDID(device.UDID), commandUUID)
		return
	default:
		log.Printf("Unknown command response status: %s", status)
		return
	}

	// Extract any result payload (for query commands like DeviceInformation)
	var resultJSON json.RawMessage
	resultKeys := []string{
		"DeviceName", "OSVersion", "BuildVersion", "ModelName", "Model",
		"SerialNumber", "ProductName", "IMEI", "MEID", "WiFiMacAddress",
		"BluetoothMAC", "EthernetMACAddresses", "AvailableDeviceCapacity",
		"DeviceCapacity", "BatteryLevel", "ModemFirmwareVersion",
		"IsSupervised", "IsDeviceLocatorServiceEnabled", "IsDoNotDisturbInEffect",
		"IsCloudBackupEnabled", "IsActivationLockEnabled", "IsRoaming",
		"Sub previamente", "SubscriberCarrierNetwork", "CarrierSettingsVersion",
		"PhoneNumber", "VoiceRoamingEnabled", "DataRoamingEnabled",
		"PersonalHotspotEnabled", "AutoFillPasswordsEnabled", "PasscodePresent",
		"PasscodeCompliant", "PasscodeCompliantWithProfile",
		"HardwareEncryptionCaps", "HardwareSecurityCaps",
	}
	result := make(map[string]interface{})
	for _, key := range resultKeys {
		val := extractPlistValue(bodyStr, key)
		if val != "" {
			result[key] = val
		}
	}
	if len(result) > 0 {
		if b, err := json.Marshal(result); err == nil {
			resultJSON = b
		}
	}

	// Update command status in database
	err := e.storage.UpdateCommandStatus(ctx, commandUUID, newStatus, resultJSON, errorCode)
	if err != nil {
		log.Printf("Failed to update command status for %s: %v", commandUUID, err)
	} else {
		log.Printf("Command %s status updated to %s (device %s)", commandUUID, newStatus, safeUDID(device.UDID))
	}

	// For acknowledged install/remove profile commands, update profile installations
	if newStatus == "acknowledged" {
		e.updateProfileInstallationStatus(ctx, commandUUID, device, bodyStr)
	}
}

// updateProfileInstallationStatus updates mdm_profile_installations when a device
// acknowledges an InstallProfile or RemoveProfile command.
func (e *Engine) updateProfileInstallationStatus(ctx context.Context, commandUUID string, device *storage.Device, bodyStr string) {
	// Look up the command to determine type
	// This is a best-effort update — failures are logged but don't block
	// We'd need a GetCommand method in storage for this; for now, skip
	// detailed profile installation tracking until Phase 3.
	_ = ctx
	_ = commandUUID
	_ = device
	_ = bodyStr
}

// ─── Device Check-Out (Unenrollment) ───

// handleCheckOut marks a device as unenrolled and cleans up MDM state.
func (e *Engine) handleCheckOut(ctx context.Context, device *storage.Device) {
	log.Printf("Device %s (%s) is checking out (unenrolling)", device.ModelName, safeUDID(device.UDID))

	err := e.storage.MarkDeviceUnenrolled(ctx, device.UDID)
	if err != nil {
		log.Printf("Failed to mark device %s as unenrolled: %v", safeUDID(device.UDID), err)
	}

	// Cancel any pending commands for this device
	err = e.storage.CancelPendingCommands(ctx, device.UDID)
	if err != nil {
		log.Printf("Failed to cancel pending commands for %s: %v", safeUDID(device.UDID), err)
	}
}

// ─── Response Helpers ───

// sendEmptyResponse sends an empty MDM response (no command).
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

// sendAuthChallenge sends a 401 with WWW-Authenticate to trigger device authentication.
func (e *Engine) sendAuthChallenge(w http.ResponseWriter, r *http.Request, udid string) {
	w.Header().Set("Content-Type", "application/x-apple-aspen-mdm-checkin")
	w.Header().Set("WWW-Authenticate", `MDMRelam="com.apple.mdm"`)
	w.WriteHeader(http.StatusUnauthorized)
}

// ─── Plist Parsing Helpers ───

// extractUDID gets the device UDID from the request.
// Priority: mTLS client cert → Mdm-Signature header → query param
func extractUDID(r *http.Request) string {
	// From mTLS client certificate (most secure)
	if r.TLS != nil && len(r.TLS.PeerCertificates) > 0 {
		// Extract UDID from cert subject CN or SAN
		// Apple mTLS certs have the UDID in the Subject CN
		for _, cert := range r.TLS.PeerCertificates {
			if cert.Subject.CommonName != "" {
				return cert.Subject.CommonName
			}
			// Check SANs for UDID
			for _, san := range cert.DNSNames {
				if strings.HasPrefix(san, "udid:") {
					return strings.TrimPrefix(san, "udid:")
				}
			}
		}
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
	return extractPlistString(string(body), "Status")
}

// extractPlistString extracts a string value for a given key from a plist XML.
// Handles <key>KEY</key><string>VALUE</string> patterns.
func extractPlistString(plist, key string) string {
	keyPattern := "<key>" + key + "</key>"
	idx := strings.Index(plist, keyPattern)
	if idx < 0 {
		return ""
	}
	rest := plist[idx+len(keyPattern):]

	// Find the next element after the key
	rest = strings.TrimLeft(rest, " \t\r\n")

	// Check for <string>VALUE</string>
	if strings.HasPrefix(rest, "<string>") {
		start := len("<string>")
		end := strings.Index(rest[start:], "</string>")
		if end >= 0 {
			return rest[start : start+end]
		}
	}

	// Check for <data>BASE64</data> (return base64 as-is)
	if strings.HasPrefix(rest, "<data>") {
		start := len("<data>")
		end := strings.Index(rest[start:], "</data>")
		if end >= 0 {
			return rest[start : start+end]
		}
	}

	// Check for <integer>VALUE</integer>
	if strings.HasPrefix(rest, "<integer>") {
		start := len("<integer>")
		end := strings.Index(rest[start:], "</integer>")
		if end >= 0 {
			return rest[start : start+end]
		}
	}

	// Check for <true/> or <false/>
	if strings.HasPrefix(rest, "<true/>") {
		return "true"
	}
	if strings.HasPrefix(rest, "<false/>") {
		return "false"
	}

	return ""
}

// extractPlistValue extracts any value (string, integer, bool, data) for a key.
func extractPlistValue(plist, key string) string {
	return extractPlistString(plist, key)
}

// ─── Utility ───

// safeUDID returns the first 8 chars of a UDID for safe logging.
func safeUDID(udid string) string {
	if len(udid) > 8 {
		return udid[:8]
	}
	return udid
}

// escapeXML escapes XML special characters.
func escapeXML(s string) string {
	r := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
		"'", "&apos;",
	)
	return r.Replace(s)
}
