// Breeze MDM Server — sidecar service that wraps NanoMDM to provide
// native Apple MDM protocol support for Breeze.
//
// Architecture:
//   - Speaks Apple MDM protocol (HTTPS endpoints for device check-in)
//   - Queues MDM commands and dispatches via APNs push
//   - Talks to Breeze API over HTTP for device/profile data
//   - Shares PostgreSQL with Breeze API (read-only access to MDM tables)
//
// Configuration via environment variables:
//   BREEZE_API_URL       - Breeze API base URL (default: http://localhost:3001)
//   MDM_LISTEN_ADDR      - Listen address (default: :8443)
//   MDM_TLS_CERT_FILE    - TLS certificate file path
//   MDM_TLS_KEY_FILE     - TLS key file path
//   DATABASE_URL         - PostgreSQL connection string (shared with API)
//   APNS_CERT_FILE       - APNs push certificate (P12/PEM)
//   APNS_KEY_FILE        - APNs private key (if not in P12)
//   APNS_TOPIC           - APNs topic (bundle ID)
//   APNS_PRODUCTION      - Use APNs production gateway (default: false = sandbox)

package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/fieldfortress-jh/breeze/mdm-server/internal/handlers"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

func main() {
	cfg := loadConfig()
	log.Printf("Breeze MDM Server starting on %s", cfg.ListenAddr)
	log.Printf("Breeze API: %s", cfg.BreezeAPIURL)
	log.Printf("APNs production: %v", cfg.APNsProduction)

	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(60 * time.Second))

	// Health check
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok","service":"breeze-mdm-server"}`))
	})

	// ─── Apple MDM Protocol Endpoints ───
	// These are called directly by Apple devices
	mdm := chi.NewRouter()

	// Enrollment profile download (user downloads this to enroll)
	mdm.Get("/enroll", handlers.HandleEnrollProfile)

	// MDM check-in endpoint (devices call this for commands/status)
	mdm.Put("/mdm", handlers.HandleMDMCheckin)

	// Command response endpoint (devices send command results here)
	mdm.Put("/connect", handlers.HandleCommandResponse)

	// Device info query (for admin/debugging)
	mdm.Get("/devices/{udid}", handlers.HandleGetDevice)

	r.Mount("/mdm", mdm)

	// ─── Internal API (called by Breeze API) ───
	internal := chi.NewRouter()

	// Queue a command for a device
	internal.Post("/commands", handlers.HandleQueueCommand)

	// Get command status
	internal.Get("/commands/{commandId}", handlers.HandleGetCommandStatus)

	// List pending commands for a device
	internal.Get("/devices/{udid}/commands", handlers.HandleListDeviceCommands)

	// Sync device from ABM
	internal.Post("/abm/sync", handlers.HandleABMSync)

	// APNs configuration
	internal.Get("/apns/config", handlers.HandleGetAPNsConfig)
	internal.Put("/apns/config", handlers.HandleUpdateAPNsConfig)

	r.Mount("/internal", internal)

	// HTTP server with TLS
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

	// Start server (TLS if certs provided, otherwise plain HTTP for dev)
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

// Config holds all server configuration
type Config struct {
	ListenAddr     string
	BreezeAPIURL   string
	DatabaseURL    string
	TLSCertFile    string
	TLSKeyFile     string
	APNSCertFile   string
	APNSKeyFile    string
	APNSTopic      string
	APNsProduction bool
}

func loadConfig() Config {
	return Config{
		ListenAddr:     getEnv("MDM_LISTEN_ADDR", ":8443"),
		BreezeAPIURL:   getEnv("BREEZE_API_URL", "http://localhost:3001"),
		DatabaseURL:    getEnv("DATABASE_URL", ""),
		TLSCertFile:    getEnv("MDM_TLS_CERT_FILE", ""),
		TLSKeyFile:     getEnv("MDM_TLS_KEY_FILE", ""),
		APNSCertFile:   getEnv("APNS_CERT_FILE", ""),
		APNSKeyFile:    getEnv("APNS_KEY_FILE", ""),
		APNSTopic:      getEnv("APNS_TOPIC", ""),
		APNsProduction: getEnv("APNS_PRODUCTION", "false") == "true",
	}
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}
