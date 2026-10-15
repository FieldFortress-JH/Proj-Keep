// Package handlers implements the HTTP handlers for the MDM server.
// This file contains the Apple MDM protocol endpoints that devices call directly.
package handlers

import (
	"encoding/xml"
	"log"
	"net/http"

	"github.com/go-chi/chi/v5"
)

// ─── Apple MDM Protocol Types ───

// MDMCommand represents an Apple MDM command
type MDMCommand struct {
	XMLName     xml.Name `xml:"plist"`
	Version     string   `xml:"version,attr"`
	CommandUUID string   `xml:"dict>key"`
	Command     struct {
		RequestType string `xml:"string"`
	} `xml:"dict>dict"`
}

// MDMResponse represents the response sent back to the device
type MDMResponse struct {
	XMLName xml.Name `xml:"plist"`
	Version string   `xml:"version,attr"`
	Dict    MDMDict  `xml:"dict"`
}

type MDMDict struct {
	CommandUUID string      `xml:"key"`
	Command     MDMCommand2 `xml:"dict"`
}

type MDMCommand2 struct {
	RequestType string `xml:"key"`
	Value       string `xml:"string"`
}

// ─── Enrollment Profile Handler ───

// handleEnrollProfile returns the .mobileconfig enrollment profile
// that a user downloads to enroll their device in MDM.
func HandleEnrollProfile(w http.ResponseWriter, r *http.Request) {
	// Query params: udid, org_id, enrollment_token
	udid := r.URL.Query().Get("udid")
	orgID := r.URL.Query().Get("org_id")
	token := r.URL.Query().Get("enrollment_token")

	log.Printf("Enrollment profile requested: udid=%s org=%s", udid, orgID)

	// TODO: Fetch enrollment profile from Breeze API
	// For now, return a placeholder profile
	profile := generateEnrollmentProfile(udid, orgID, token)

	w.Header().Set("Content-Type", "application/x-apple-aspen-config")
	w.Header().Set("Content-Disposition", `attachment; filename="breeze-mdm-enrollment.mobileconfig"`)
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(profile))
}

// generateEnrollmentProfile creates a basic MDM enrollment .mobileconfig
func generateEnrollmentProfile(udid, orgID, token string) string {
	return `<?xml version="1.0" encoding="UTF-8"?>
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
			<string>com.breeze.mdm.` + udid + `</string>
			<key>PayloadUUID</key>
			<string>ENROLLMENT-UUID-PLACEHOLDER</string>
			<key>PayloadEnabled</key>
			<true/>
			<key>PayloadDisplayName</key>
			<string>Breeze MDM Enrollment</string>
			<key>PayloadDescription</key>
			<string>Enrolls this device in Breeze MDM</string>
			<key>PayloadOrganization</key>
			<string>Breeze</string>
			<key>PayloadRemovalDisallowed</key>
			<true/>
			<key>PayloadScope</key>
			<string>System</string>
			<key>ServerURL</key>
			<string>https://mdm.breeze.lan/mdm/mdm</string>
			<key>CheckInURL</key>
			<string>https://mdm.breeze.lan/mdm/connect</string>
			<key>CheckOutURL</key>
			<string>https://mdm.breeze.lan/mdm/enroll</string>
			<key>AccessRights</key>
			<integer>8191</integer>
			<key>Topic</key>
			<string>com.breeze.mdm.push</string>
			<key>EnrollmentMode</key>
			<string>BYOD</string>
		</dict>
	</array>
	<key>PayloadDisplayName</key>
	<string>Breeze MDM Enrollment</string>
	<key>PayloadIdentifier</key>
	<string>com.breeze.mdm.enrollment.` + udid + `</string>
	<key>PayloadType</key>
	<string>Configuration</string>
	<key>PayloadUUID</key>
	<string>ENROLLMENT-UUID-PLACEHOLDER</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
	<key>PayloadRemovalDisallowed</key>
	<true/>
	<key>PayloadScope</key>
	<string>System</string>
	<key>ConsentText</key>
	<dict>
		<key>default</key>
		<string>This device will be enrolled in Breeze MDM management. Your administrator will be able to manage this device remotely.</string>
	</dict>
</dict>
</plist>`
}

// ─── MDM Check-in Handler ───

// handleMDMCheckin handles the main MDM protocol endpoint where devices
// check in to receive commands and report status.
//
// Apple MDM protocol flow:
//   - Device sends "CheckOut" when unenrolling → we return empty response
//   - Device sends "Idle" when no commands pending → we return queued commands
//   - Device sends "Acknowledged" / "Error" / "NotNow" → we process the response
func HandleMDMCheckin(w http.ResponseWriter, r *http.Request) {
	// Extract UDID from device certificate or header
	udid := r.Header.Get("Mdm-Signature-Udid")
	if udid == "" {
		udid = r.URL.Query().Get("udid")
	}

	// Read the request body (plist XML from device)
	body := make([]byte, 0)
	buf := make([]byte, 4096)
	for {
		n, err := r.Body.Read(buf)
		if n > 0 {
			body = append(body, buf[:n]...)
		}
		if err != nil {
			break
		}
	}

	log.Printf("MDM check-in from device: %s (%d bytes)", udid, len(body))

	// TODO: Parse the plist, determine device state machine status
	// For now, return an empty response (no commands)
	response := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CommandUUID</key>
	<string></string>
	<key>Command</key>
	<dict/>
</dict>
</plist>`

	w.Header().Set("Content-Type", "application/x-apple-aspen-mdm-checkin")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(response))
}

// ─── Command Response Handler ───

// handleCommandResponse handles device responses to MDM commands
// (Acknowledged, Error, NotNow status updates)
func HandleCommandResponse(w http.ResponseWriter, r *http.Request) {
	udid := r.Header.Get("Mdm-Signature-Udid")
	if udid == "" {
		udid = r.URL.Query().Get("udid")
	}

	// Read command response
	body := make([]byte, 0)
	buf := make([]byte, 4096)
	for {
		n, err := r.Body.Read(buf)
		if n > 0 {
			body = append(body, buf[:n]...)
		}
		if err != nil {
			break
		}
	}

	log.Printf("Command response from device %s: %d bytes", udid, len(body))

	// TODO: Parse the response, update command status in database
	// TODO: Notify Breeze API of the status update

	w.WriteHeader(http.StatusOK)
}

// ─── Device Info Handler ───

// handleGetDevice returns MDM information about a specific device
func HandleGetDevice(w http.ResponseWriter, r *http.Request) {
	udid := chi.URLParam(r, "udid")
	log.Printf("Get device info: %s", udid)

	// TODO: Fetch from database
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"udid":"` + udid + `","mdm_enrolled":true,"status":"active"}`))
}
