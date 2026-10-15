// Package handlers — internal API endpoints called by the Breeze API.
package handlers

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/go-chi/chi/v5"
)

// CommandRequest represents a command to queue for a device
type CommandRequest struct {
	DeviceUDID  string                 `json:"device_udid"`
	CommandType string                 `json:"command_type"`
	Payload     map[string]interface{} `json:"payload,omitempty"`
	CreatedBy   string                 `json:"created_by,omitempty"`
}

// CommandResponse represents the result of queueing a command
type CommandResponse struct {
	CommandID string `json:"command_id"`
	Status    string `json:"status"`
	Message   string `json:"message,omitempty"`
}

// handleQueueCommand queues an MDM command for a device.
// Called by Breeze API when an admin sends a command (lock, wipe, install profile, etc.)
func HandleQueueCommand(w http.ResponseWriter, r *http.Request) {
	var req CommandRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	log.Printf("Queue command: type=%s device=%s", req.CommandType, req.DeviceUDID)

	// TODO: Insert into mdm_commands table
	// TODO: Send APNs push to wake the device
	// TODO: Return command ID for tracking

	resp := CommandResponse{
		CommandID: "cmd-placeholder-uuid",
		Status:    "queued",
		Message:   "Command queued for delivery",
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(resp)
}

// handleGetCommandStatus returns the status of a queued command
func HandleGetCommandStatus(w http.ResponseWriter, r *http.Request) {
	commandID := chi.URLParam(r, "commandId")
	log.Printf("Get command status: %s", commandID)

	// TODO: Fetch from mdm_commands table

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"command_id": commandID,
		"status":     "pending",
	})
}

// handleListDeviceCommands lists pending/completed commands for a device
func HandleListDeviceCommands(w http.ResponseWriter, r *http.Request) {
	udid := chi.URLParam(r, "udid")
	log.Printf("List commands for device: %s", udid)

	// TODO: Query mdm_commands table

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"device_udid": udid,
		"commands":    []interface{}{},
	})
}

// handleABMSync triggers a sync with Apple Business Manager
func HandleABMSync(w http.ResponseWriter, r *http.Request) {
	log.Println("ABM sync requested")

	// TODO: Fetch ABM token from mdm_apns_config
	// TODO: Call Apple ABM API to sync devices
	// TODO: Upsert devices into devices table

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "sync_started",
		"message": "ABM sync initiated",
	})
}

// handleGetAPNsConfig returns the APNs configuration for an org
func HandleGetAPNsConfig(w http.ResponseWriter, r *http.Request) {
	orgID := r.URL.Query().Get("org_id")
	log.Printf("Get APNs config for org: %s", orgID)

	// TODO: Fetch from mdm_apns_config (decrypt cert)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"org_id":         orgID,
		"configured":     false,
		"cert_expiry":    nil,
		"abm_enabled":    false,
		"abm_last_sync":  nil,
	})
}

// handleUpdateAPNsConfig updates APNs/ABM configuration for an org
func HandleUpdateAPNsConfig(w http.ResponseWriter, r *http.Request) {
	log.Println("Update APNs config requested")

	// TODO: Accept cert upload, encrypt, store in mdm_apns_config

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "updated",
		"message": "APNs configuration saved",
	})
}
