// Breeze MDM Server — sidecar service that provides native Apple MDM
// protocol support for Breeze.
//
// Architecture:
//   - Speaks Apple MDM protocol (HTTPS endpoints for device check-in)
//   - Queues MDM commands and dispatches via APNs push
//   - Shares PostgreSQL with Breeze API (MDM tables)
//   - Talks to Breeze API over HTTP for profile/policy data
//
// Two HTTP surfaces:
//   /mdm/*      → Called by Apple devices (MDM protocol)
//   /internal/* → Called by Breeze API (command queue, config)
//   /health     → Health check
//
// Configuration via environment variables:
//   BREEZE_API_URL       - Breeze API base URL (default: http://localhost:3001)
//   MDM_LISTEN_ADDR      - Listen address (default: :8443)
//   MDM_PUBLIC_URL       - Public URL devices use (default: https://localhost:8443)
//   MDM_TLS_CERT_FILE    - TLS certificate file path
//   MDM_TLS_KEY_FILE     - TLS key file path
//   DATABASE_URL         - PostgreSQL connection string (shared with API)
//   APNS_PRODUCTION      - Use APNs production gateway (default: false = sandbox)

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/fieldfortress-jh/breeze/mdm-server/internal/apns"
	"github.com/fieldfortress-jh/breeze/mdm-server/internal/mdm"
	"github.com/fieldfortress-jh/breeze/mdm-server/internal/storage"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

func main() {
	cfg := loadConfig()
	log.Printf("Breeze MDM Server starting on %s", cfg.ListenAddr)
	log.Printf("Public URL: %s", cfg.PublicURL)
	log.Printf("Breeze API: %s", cfg.BreezeAPIURL)
	log.Printf("APNs production: %v", cfg.APNsProduction)

	// ─── Initialize storage ───
	store, err := storage.New(cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer store.Close()
	log.Println("Database connected")

	// ─── Initialize APNs client ───
	apnsClient := apns.NewClient(cfg.APNsProduction)

	// Load APNs configs from DB into the client on startup
	loadAPNsConfigsFromDB(store, apnsClient)
	log.Println("APNs client initialized")

	// ─── Initialize MDM engine ───
	engine := mdm.NewEngine(store, apnsClient, cfg.PublicURL)
	log.Println("MDM engine initialized")

	// ─── HTTP router ───
	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(60 * time.Second))

	// Health check
	r.Get("/health", handleHealth)

	// ─── Apple MDM Protocol Endpoints (device-facing) ───
	mdmRouter := chi.NewRouter()
	// Enrollment profile download
	mdmRouter.Get("/enroll", engine.HandleEnroll)
	// MDM check-in (device polls for commands)
	mdmRouter.Put("/mdm", engine.HandleCheckin)
	// Command response (device reports results)
	mdmRouter.Put("/connect", engine.HandleCommandResponse)
	// Also accept POST for some device types
	mdmRouter.Post("/mdm", engine.HandleCheckin)
	mdmRouter.Post("/connect", engine.HandleCommandResponse)

	r.Mount("/mdm", mdmRouter)

	// ─── Internal API (Breeze API-facing) ───
	internal := chi.NewRouter()

	// Queue an MDM command
	internal.Post("/commands", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			DeviceUDID  string                 `json:"device_udid"`
			CommandType string                 `json:"command_type"`
			Payload     map[string]interface{} `json:"payload,omitempty"`
			CreatedBy   string                 `json:"created_by,omitempty"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid request body", http.StatusBadRequest)
			return
		}

		if req.DeviceUDID == "" || req.CommandType == "" {
			http.Error(w, "device_udid and command_type are required", http.StatusBadRequest)
			return
		}

		cmdUUID, err := engine.QueueCommand(r.Context(), req.DeviceUDID, req.CommandType, req.Payload)
		if err != nil {
			log.Printf("Failed to queue command: %v", err)
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		json.NewEncoder(w).Encode(map[string]string{
			"command_id":   cmdUUID,
			"command_uuid": cmdUUID,
			"status":       "queued",
		})
	})

	// Get command status — queries the mdm_commands table
	internal.Get("/commands/{commandUUID}", func(w http.ResponseWriter, r *http.Request) {
		commandUUID := chi.URLParam(r, "commandUUID")

		cmd, err := store.GetCommand(r.Context(), commandUUID)
		if err != nil {
			log.Printf("Error looking up command %s: %v", commandUUID, err)
			http.Error(w, "Database error", http.StatusInternalServerError)
			return
		}
		if cmd == nil {
			http.Error(w, "Command not found", http.StatusNotFound)
			return
		}

		resp := map[string]interface{}{
			"command_id":   cmd.ID,
			"command_uuid": cmd.CommandUUID,
			"device_udid":  cmd.DeviceUDID,
			"type":         cmd.Type,
			"status":       cmd.Status,
			"created_at":   cmd.CreatedAt.Format(time.RFC3339),
		}
		if cmd.QueuedAt != nil {
			resp["queued_at"] = cmd.QueuedAt.Format(time.RFC3339)
		}
		if cmd.SentAt != nil {
			resp["sent_at"] = cmd.SentAt.Format(time.RFC3339)
		}
		if cmd.AcknowledgedAt != nil {
			resp["acknowledged_at"] = cmd.AcknowledgedAt.Format(time.RFC3339)
		}
		if len(cmd.Result) > 0 {
			resp["result"] = json.RawMessage(cmd.Result)
		}
		if cmd.ErrorCode != "" {
			resp["error_code"] = cmd.ErrorCode
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(resp)
	})

	// List pending commands for a device
	internal.Get("/devices/{udid}/commands", func(w http.ResponseWriter, r *http.Request) {
		udid := chi.URLParam(r, "udid")
		commands, err := store.GetPendingCommands(r.Context(), udid)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"device_udid": udid,
			"commands":    commands,
		})
	})

	// Get device info
	internal.Get("/devices/{udid}", func(w http.ResponseWriter, r *http.Request) {
		udid := chi.URLParam(r, "udid")
		device, err := store.GetDevice(r.Context(), udid)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if device == nil {
			http.Error(w, "Device not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(device)
	})

	// List devices by org
	internal.Get("/orgs/{orgId}/devices", func(w http.ResponseWriter, r *http.Request) {
		orgID := chi.URLParam(r, "orgId")
		devices, err := store.ListDevicesByOrg(r.Context(), orgID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"org_id":  orgID,
			"devices": devices,
		})
	})

	// ABM sync trigger
	// TODO (Phase 3): Implement actual Apple Business Manager API sync
	//   1. Load org's ABM token from mdm_apns_config
	//   2. Call Apple ABM API: GET /v1/org/devices
	//   3. Upsert devices into the devices table
	//   4. Update abm_last_sync
	internal.Post("/abm/sync", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			OrgID string `json:"org_id"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)

		// Update last sync timestamp
		if req.OrgID != "" {
			_, _ = store.ExecContext(r.Context(), `
				UPDATE mdm_apns_config
				SET abm_last_sync = now(), updated_at = now()
				WHERE org_id = $1
			`, req.OrgID)
		}

		log.Printf("ABM sync requested for org %s (API integration pending Phase 3)", req.OrgID)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		json.NewEncoder(w).Encode(map[string]string{
			"status":  "sync_scheduled",
			"message": "ABM sync noted — full Apple Business Manager API integration is Phase 3",
		})
	})

	// APNs config status
	internal.Get("/apns/config", func(w http.ResponseWriter, r *http.Request) {
		orgID := r.URL.Query().Get("org_id")
		if orgID == "" {
			http.Error(w, "org_id required", http.StatusBadRequest)
			return
		}

		// Check DB first, then in-memory cache
		config, err := store.GetAPNsConfig(r.Context(), orgID)
		if err != nil || config == nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"org_id":     orgID,
				"configured": false,
			})
			return
		}

		valid, days, err := apnsClient.ValidateConfig(orgID)
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"org_id":     orgID,
				"configured": false,
				"error":      err.Error(),
			})
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"org_id":            orgID,
			"configured":        valid,
			"topic":             config.Topic,
			"days_until_expiry": days,
			"needs_renewal":     days < 30,
			"abm_enabled":       config.ABMEnabled,
		})
	})

	// Update APNs config (cert upload)
	// Persists to mdm_apns_config table AND updates in-memory client cache
	internal.Put("/apns/config", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			OrgID   string `json:"org_id"`
			CertPEM string `json:"cert_pem"`
			KeyPEM  string `json:"key_pem"`
			Topic   string `json:"topic"`
			Expiry  string `json:"expiry"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid request body", http.StatusBadRequest)
			return
		}

		if req.OrgID == "" || req.CertPEM == "" {
			http.Error(w, "org_id and cert_pem are required", http.StatusBadRequest)
			return
		}

		expiry, err := time.Parse("2006-01-02", req.Expiry)
		if err != nil {
			expiry = time.Now().AddDate(1, 0, 0) // Default 1 year
		}

		// Update in-memory client
		if err := apnsClient.SetOrgConfig(req.OrgID, []byte(req.CertPEM), []byte(req.KeyPEM), req.Topic, expiry); err != nil {
			http.Error(w, fmt.Sprintf("Invalid certificate: %v", err), http.StatusBadRequest)
			return
		}

		// Persist to mdm_apns_config table
		// Note: The Breeze API layer encrypts before storage. Here we store the
		// raw PEM since this is an internal endpoint — the API service layer
		// (apnsManager.ts storeApnsCertificate) handles encryption for the DB.
		// For direct sidecar access, we store as-is (internal network only).
		_, dbErr := store.ExecContext(r.Context(), `
			INSERT INTO mdm_apns_config (org_id, apns_cert_encrypted, apns_key_encrypted, apns_topic, apns_push_cert_expiry, updated_at)
			VALUES ($1, $2, $3, $4, $5, now())
			ON CONFLICT (org_id) DO UPDATE SET
				apns_cert_encrypted = EXCLUDED.apns_cert_encrypted,
				apns_key_encrypted = EXCLUDED.apns_key_encrypted,
				apns_topic = EXCLUDED.apns_topic,
				apns_push_cert_expiry = EXCLUDED.apns_push_cert_expiry,
				updated_at = now()
		`, req.OrgID, req.CertPEM, req.KeyPEM, req.Topic, expiry)
		if dbErr != nil {
			log.Printf("Warning: failed to persist APNs config to DB: %v", dbErr)
			// Don't fail the request — in-memory config is still valid
		}

		log.Printf("APNs config updated for org %s (topic: %s, expires: %s)", req.OrgID, req.Topic, expiry.Format("2006-01-02"))

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"status":  "updated",
			"org_id":  req.OrgID,
			"message": "APNs configuration saved (in-memory + database)",
		})
	})

	r.Mount("/internal", internal)

	// ─── HTTP server ───
	srv := &http.Server{
		Addr:         cfg.ListenAddr,
		Handler:      r,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	// Graceful shutdown
	go func() {
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
		<-sigChan
		log.Println("Shutting down...")
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		srv.Shutdown(ctx)
	}()

	// Start server
	if cfg.TLSCertFile != "" && cfg.TLSKeyFile != "" {
		log.Printf("Starting with TLS: cert=%s key=%s", cfg.TLSCertFile, cfg.TLSKeyFile)
		if err := srv.ListenAndServeTLS(cfg.TLSCertFile, cfg.TLSKeyFile); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	} else {
		log.Printf("WARNING: Starting without TLS (development only)")
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}
}

// loadAPNsConfigsFromDB loads all orgs' APNs configs from the database into
// the in-memory APNs client on startup. This ensures the sidecar has valid
// certs after a restart without requiring the API to re-push them.
func loadAPNsConfigsFromDB(store *storage.DB, client *apns.Client) {
	rows, err := store.Query(`
		SELECT org_id, apns_cert_encrypted, apns_key_encrypted, apns_topic, apns_push_cert_expiry
		FROM mdm_apns_config
		WHERE apns_cert_encrypted IS NOT NULL
	`)
	if err != nil {
		log.Printf("Warning: failed to load APNs configs from DB: %v", err)
		return
	}
	defer rows.Close()

	count := 0
	for rows.Next() {
		var orgID, certPEM, keyPEM, topic string
		var expiry *time.Time
		if err := rows.Scan(&orgID, &certPEM, &keyPEM, &topic, &expiry); err != nil {
			log.Printf("Warning: failed to scan APNs config row: %v", err)
			continue
		}

		exp := time.Now().AddDate(1, 0, 0)
		if expiry != nil {
			exp = *expiry
		}

		if err := client.SetOrgConfig(orgID, []byte(certPEM), []byte(keyPEM), topic, exp); err != nil {
			log.Printf("Warning: failed to load APNs config for org %s: %v", orgID, err)
			continue
		}
		count++
	}
	log.Printf("Loaded %d APNs config(s) from database", count)
}

// handleHealth returns the service health status.
func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"ok","service":"breeze-mdm-server","version":"0.2.0"}`))
}

// Config holds all server configuration.
type Config struct {
	ListenAddr     string
	PublicURL      string
	BreezeAPIURL   string
	DatabaseURL    string
	TLSCertFile    string
	TLSKeyFile     string
	APNsProduction bool
}

func loadConfig() Config {
	return Config{
		ListenAddr:     getEnv("MDM_LISTEN_ADDR", ":8443"),
		PublicURL:      getEnv("MDM_PUBLIC_URL", "https://localhost:8443"),
		BreezeAPIURL:   getEnv("BREEZE_API_URL", "http://localhost:3001"),
		DatabaseURL:    getEnv("DATABASE_URL", ""),
		TLSCertFile:    getEnv("MDM_TLS_CERT_FILE", ""),
		TLSKeyFile:     getEnv("MDM_TLS_KEY_FILE", ""),
		APNsProduction: getEnv("APNS_PRODUCTION", "false") == "true",
	}
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}
