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
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid request body", http.StatusBadRequest)
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
			"command_uuid": cmdUUID,
			"status":       "queued",
		})
	})

	// Get command status
	internal.Get("/commands/{commandUUID}", func(w http.ResponseWriter, r *http.Request) {
		commandUUID := chi.URLParam(r, "commandUUID")
		// TODO: Query mdm_commands table for status
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"command_uuid": commandUUID,
			"status":       "pending",
		})
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
	internal.Post("/abm/sync", func(w http.ResponseWriter, r *http.Request) {
		// TODO: Implement ABM sync via Apple Business Manager API
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		json.NewEncoder(w).Encode(map[string]string{
			"status":  "sync_started",
			"message": "ABM sync initiated (not yet implemented)",
		})
	})

	// APNs config status
	internal.Get("/apns/config", func(w http.ResponseWriter, r *http.Request) {
		orgID := r.URL.Query().Get("org_id")
		if orgID == "" {
			http.Error(w, "org_id required", http.StatusBadRequest)
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
			"days_until_expiry": days,
			"needs_renewal":     days < 30,
		})
	})

	// Update APNs config (cert upload)
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

		expiry, err := time.Parse("2006-01-02", req.Expiry)
		if err != nil {
			expiry = time.Now().AddDate(1, 0, 0) // Default 1 year
		}

		if err := apnsClient.SetOrgConfig(req.OrgID, []byte(req.CertPEM), []byte(req.KeyPEM), req.Topic, expiry); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		// TODO: Also persist to mdm_apns_config table (encrypted)

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"status":  "updated",
			"org_id":  req.OrgID,
			"message": "APNs configuration saved",
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

// handleHealth returns the service health status.
func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"ok","service":"breeze-mdm-server","version":"0.1.0"}`))
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
