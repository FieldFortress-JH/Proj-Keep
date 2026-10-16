// Package storage implements the MDM sidecar's storage interfaces backed by PostgreSQL.
// This connects the MDM sidecar to the same database Breeze uses, so MDM
// devices, commands, and profiles are all in one place.
package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	_ "github.com/lib/pq"
)

// DB wraps a PostgreSQL connection for MDM storage operations.
type DB struct {
	*sql.DB
}

// New creates a new MDM storage instance backed by PostgreSQL.
func New(databaseURL string) (*DB, error) {
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	// Verify connection
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	return &DB{db}, nil
}

// ─── Device Storage ───

// Device represents an MDM-enrolled device in storage.
type Device struct {
	ID                  string    `json:"id"`
	UDID                string    `json:"udid"`
	SerialNumber        string    `json:"serial_number,omitempty"`
	OrgID               string    `json:"org_id"`
	SiteID              string    `json:"site_id,omitempty"`
	EnrolledAt          time.Time `json:"enrolled_at"`
	LastCheckin         time.Time `json:"last_checkin"`
	Supervised          bool      `json:"supervised"`
	ActivationLock      bool      `json:"activation_lock"`
	OSVersion           string    `json:"os_version,omitempty"`
	Product             string    `json:"product,omitempty"`
	ModelName           string    `json:"model_name,omitempty"`
	EnrollmentType      string    `json:"enrollment_type"`
	APNsToken           string    `json:"apns_token,omitempty"`
	PushMagic           string    `json:"push_magic,omitempty"`
	AwaitingConfiguration bool    `json:"awaiting_configuration"`
}

// GetDevice retrieves a device by UDID.
func (db *DB) GetDevice(ctx context.Context, udid string) (*Device, error) {
	row := db.QueryRowContext(ctx, `
		SELECT id, mdm_udid, mdm_serial_number, org_id, site_id, enrolled_at,
		       mdm_last_checkin, mdm_supervised, mdm_activation_lock_enabled,
		       os_version, mdm_product, mdm_model_name, mdm_enrollment_type
		FROM devices
		WHERE mdm_udid = $1 AND mdm_enrolled = true
		LIMIT 1
	`, udid)

	var d Device
	var lastCheckin, enrolledAt sql.NullTime
	var siteID sql.NullString
	err := row.Scan(
		&d.ID, &d.UDID, &d.SerialNumber, &d.OrgID, &siteID, &enrolledAt,
		&lastCheckin, &d.Supervised, &d.ActivationLock,
		&d.OSVersion, &d.Product, &d.ModelName, &d.EnrollmentType,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if siteID.Valid {
		d.SiteID = siteID.String
	}
	if lastCheckin.Valid {
		d.LastCheckin = lastCheckin.Time
	}
	if enrolledAt.Valid {
		d.EnrolledAt = enrolledAt.Time
	}
	return &d, nil
}

// UpsertDevice creates or updates a device record.
// Uses the device's org's default site if no site is specified.
func (db *DB) UpsertDevice(ctx context.Context, d *Device) error {
	// Resolve site_id: use provided, or get the org's first site
	siteID := d.SiteID
	if siteID == "" {
		siteID = db.getDefaultSiteID(ctx, d.OrgID)
	}

	_, err := db.ExecContext(ctx, `
		INSERT INTO devices (
			id, org_id, site_id, agent_id, hostname, os_type, os_version,
			architecture, agent_version, status, mdm_enrolled, mdm_udid,
			mdm_serial_number, mdm_product, mdm_model_name, mdm_supervised,
			mdm_activation_lock_enabled, mdm_last_checkin, mdm_enrollment_type,
			last_seen_at, enrolled_at
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, $11,
			$12, $13, $14, $15, $16, $17, $18, $19, $20
		)
		ON CONFLICT (mdm_udid) WHERE mdm_udid IS NOT NULL DO UPDATE SET
			mdm_serial_number = EXCLUDED.mdm_serial_number,
			mdm_product = EXCLUDED.mdm_product,
			mdm_model_name = EXCLUDED.mdm_model_name,
			mdm_supervised = EXCLUDED.mdm_supervised,
			mdm_activation_lock_enabled = EXCLUDED.mdm_activation_lock_enabled,
			mdm_last_checkin = EXCLUDED.mdm_last_checkin,
			last_seen_at = EXCLUDED.last_seen_at,
			status = 'online',
			updated_at = now()
	`,
		d.ID, d.OrgID, siteID,
		"mdm-"+d.UDID, d.ModelName, deviceOSType(d.Product), d.OSVersion,
		"arm64", "mdm-1.0", "online", d.UDID,
		d.SerialNumber, d.Product, d.ModelName, d.Supervised,
		d.ActivationLock, d.LastCheckin, d.EnrollmentType,
		d.LastCheckin, d.EnrolledAt,
	)
	return err
}

// getDefaultSiteID returns the first site for an org, or a nil UUID if none exists.
// The devices.site_id column is NOT NULL, so we need a valid value.
func (db *DB) getDefaultSiteID(ctx context.Context, orgID string) string {
	var siteID string
	err := db.QueryRowContext(ctx, `
		SELECT id FROM sites WHERE org_id = $1 ORDER BY created_at ASC LIMIT 1
	`, orgID).Scan(&siteID)
	if err != nil {
		// No sites for this org — use nil UUID (will fail FK if enforced)
		// This is a lab/dev fallback; in production, orgs always have at least one site
		return "00000000-0000-0000-0000-000000000000"
	}
	return siteID
}

// UpdateDeviceCheckin updates the last check-in time for a device.
func (db *DB) UpdateDeviceCheckin(ctx context.Context, udid string) error {
	_, err := db.ExecContext(ctx, `
		UPDATE devices
		SET mdm_last_checkin = now(), last_seen_at = now(), status = 'online', updated_at = now()
		WHERE mdm_udid = $1
	`, udid)
	return err
}

// MarkDeviceUnenrolled marks a device as no longer MDM-enrolled.
// Called when a device sends a CheckOut request.
func (db *DB) MarkDeviceUnenrolled(ctx context.Context, udid string) error {
	_, err := db.ExecContext(ctx, `
		UPDATE devices
		SET mdm_enrolled = false,
		    status = 'offline',
		    updated_at = now()
		WHERE mdm_udid = $1
	`, udid)
	return err
}

// CancelPendingCommands cancels all pending/queued commands for a device.
// Called when a device unenrolls (CheckOut).
func (db *DB) CancelPendingCommands(ctx context.Context, udid string) error {
	_, err := db.ExecContext(ctx, `
		UPDATE mdm_commands
		SET status = 'cancelled'
		WHERE device_id IN (SELECT id FROM devices WHERE mdm_udid = $1)
		  AND status IN ('pending', 'queued')
	`, udid)
	return err
}

// ListDevicesByOrg lists all MDM-enrolled devices for an organization.
func (db *DB) ListDevicesByOrg(ctx context.Context, orgID string) ([]*Device, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT id, mdm_udid, mdm_serial_number, org_id, site_id, enrolled_at,
		       mdm_last_checkin, mdm_supervised, mdm_activation_lock_enabled,
		       os_version, mdm_product, mdm_model_name, mdm_enrollment_type
		FROM devices
		WHERE org_id = $1 AND mdm_enrolled = true
		ORDER BY mdm_last_checkin DESC NULLS LAST
	`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var devices []*Device
	for rows.Next() {
		var d Device
		var lastCheckin, enrolledAt sql.NullTime
		var siteID sql.NullString
		if err := rows.Scan(
			&d.ID, &d.UDID, &d.SerialNumber, &d.OrgID, &siteID, &enrolledAt,
			&lastCheckin, &d.Supervised, &d.ActivationLock,
			&d.OSVersion, &d.Product, &d.ModelName, &d.EnrollmentType,
		); err != nil {
			return nil, err
		}
		if siteID.Valid {
			d.SiteID = siteID.String
		}
		if lastCheckin.Valid {
			d.LastCheckin = lastCheckin.Time
		}
		if enrolledAt.Valid {
			d.EnrolledAt = enrolledAt.Time
		}
		devices = append(devices, &d)
	}
	return devices, rows.Err()
}

// ─── Command Storage ───

// Command represents an MDM command in storage.
type Command struct {
	ID          string          `json:"id"`
	DeviceUDID  string          `json:"device_udid"`
	CommandUUID string          `json:"command_uuid"`
	Type        string          `json:"type"`
	Status      string          `json:"status"`
	Payload     json.RawMessage `json:"payload,omitempty"`
	Result      json.RawMessage `json:"result,omitempty"`
	ErrorCode   string          `json:"error_code,omitempty"`
	CreatedAt   time.Time       `json:"created_at"`
	QueuedAt    *time.Time      `json:"queued_at,omitempty"`
	SentAt      *time.Time      `json:"sent_at,omitempty"`
	AcknowledgedAt *time.Time   `json:"acknowledged_at,omitempty"`
}

// QueueCommand adds a command to the queue for a device.
func (db *DB) QueueCommand(ctx context.Context, deviceUDID, commandType string, payload json.RawMessage) (*Command, error) {
	cmdUUID := uuid.New().String()
	deviceID := ""

	// Get device ID and verify enrollment
	err := db.QueryRowContext(ctx, `
		SELECT id FROM devices WHERE mdm_udid = $1 AND mdm_enrolled = true LIMIT 1
	`, deviceUDID).Scan(&deviceID)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("device not found or not enrolled: %s", deviceUDID)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to look up device: %w", err)
	}

	_, err = db.ExecContext(ctx, `
		INSERT INTO mdm_commands (
			device_id, command_type, command_uuid, status, payload, created_at, queued_at, expires_at
		) VALUES ($1, $2, $3, 'queued', $4, now(), now(), now() + interval '24 hours')
	`, deviceID, commandType, cmdUUID, payload)
	if err != nil {
		return nil, fmt.Errorf("failed to queue command: %w", err)
	}

	return &Command{
		ID:          "", // Will be populated on retrieval
		CommandUUID: cmdUUID,
		DeviceUDID:  deviceUDID,
		Type:        commandType,
		Status:      "queued",
		Payload:     payload,
		CreatedAt:   time.Now(),
	}, nil
}

// GetCommand retrieves a single command by its UUID.
func (db *DB) GetCommand(ctx context.Context, commandUUID string) (*Command, error) {
	row := db.QueryRowContext(ctx, `
		SELECT c.id, c.command_uuid, c.command_type, c.status, c.payload,
		       c.result_payload, c.error_code, c.created_at, c.queued_at, c.sent_at, c.acknowledged_at,
		       d.mdm_udid
		FROM mdm_commands c
		JOIN devices d ON c.device_id = d.id
		WHERE c.command_uuid = $1
		LIMIT 1
	`, commandUUID)

	var c Command
	var resultPayload, payload sql.NullString
	var errorCode sql.NullString
	var queuedAt, sentAt, acknowledgedAt sql.NullTime
	err := row.Scan(
		&c.ID, &c.CommandUUID, &c.Type, &c.Status, &payload,
		&resultPayload, &errorCode, &c.CreatedAt, &queuedAt, &sentAt, &acknowledgedAt,
		&c.DeviceUDID,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if payload.Valid {
		c.Payload = json.RawMessage(payload.String)
	}
	if resultPayload.Valid {
		c.Result = json.RawMessage(resultPayload.String)
	}
	if errorCode.Valid {
		c.ErrorCode = errorCode.String
	}
	if queuedAt.Valid {
		c.QueuedAt = &queuedAt.Time
	}
	if sentAt.Valid {
		c.SentAt = &sentAt.Time
	}
	if acknowledgedAt.Valid {
		c.AcknowledgedAt = &acknowledgedAt.Time
	}
	return &c, nil
}

// GetPendingCommands retrieves commands waiting to be delivered to a device.
func (db *DB) GetPendingCommands(ctx context.Context, deviceUDID string) ([]*Command, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT c.id, c.command_uuid, c.command_type, c.status, c.payload, c.created_at
		FROM mdm_commands c
		JOIN devices d ON c.device_id = d.id
		WHERE d.mdm_udid = $1
		  AND c.status IN ('pending', 'queued')
		  AND (c.expires_at IS NULL OR c.expires_at > now())
		ORDER BY c.created_at ASC
		LIMIT 10
	`, deviceUDID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var commands []*Command
	for rows.Next() {
		var c Command
		var payload sql.NullString
		if err := rows.Scan(&c.ID, &c.CommandUUID, &c.Type, &c.Status, &payload, &c.CreatedAt); err != nil {
			return nil, err
		}
		if payload.Valid {
			c.Payload = json.RawMessage(payload.String)
		}
		c.DeviceUDID = deviceUDID
		commands = append(commands, &c)
	}
	return commands, rows.Err()
}

// UpdateCommandStatus updates a command's status.
func (db *DB) UpdateCommandStatus(ctx context.Context, commandUUID, status string, result json.RawMessage, errorCode string) error {
	_, err := db.ExecContext(ctx, `
		UPDATE mdm_commands
		SET status = $1,
		    result_payload = COALESCE($2, result_payload),
		    error_code = COALESCE($3, error_code),
		    sent_at = CASE WHEN $1 = 'sent' AND sent_at IS NULL THEN now() ELSE sent_at END,
		    acknowledged_at = CASE WHEN $1 = 'acknowledged' AND acknowledged_at IS NULL THEN now() ELSE acknowledged_at END
		WHERE command_uuid = $4
	`, status, result, errorCode, commandUUID)
	return err
}

// ─── Profile Storage ───

// Profile represents an MDM configuration profile.
type Profile struct {
	ID              string   `json:"id"`
	OrgID           string   `json:"org_id"`
	Name            string   `json:"name"`
	Identifier      string   `json:"identifier"`
	UUID            string   `json:"uuid"`
	DisplayName     string   `json:"display_name"`
	Payload         string   `json:"payload"` // Signed .mobileconfig XML
	TargetPlatforms []string `json:"target_platforms"`
	Status          string   `json:"status"`
}

// GetProfile retrieves a profile by ID.
func (db *DB) GetProfile(ctx context.Context, profileID string) (*Profile, error) {
	row := db.QueryRowContext(ctx, `
		SELECT id, org_id, name, profile_identifier, profile_uuid,
		       profile_display_name, profile_payload, target_platforms, status
		FROM mdm_profiles
		WHERE id = $1
	`, profileID)

	var p Profile
	var platforms []byte
	err := row.Scan(&p.ID, &p.OrgID, &p.Name, &p.Identifier, &p.UUID, &p.DisplayName, &p.Payload, &platforms, &p.Status)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(platforms, &p.TargetPlatforms); err != nil {
		p.TargetPlatforms = []string{"ios", "ipados", "macos"}
	}
	return &p, nil
}

// GetProfilesForDevice returns profiles that should be installed on a device
// based on the device's assigned configuration policies.
//
// Resolution chain:
//   1. Find the device's org and site
//   2. Find configuration policies assigned to the device's site (or org-wide)
//   3. For each policy with an 'mdm_profile' feature link, get the profile IDs
//      from config_policy_mdm_profile_settings
//   4. Return the active profiles matching those IDs
//
// If no policies are assigned, returns all active profiles for the org (lab mode).
func (db *DB) GetProfilesForDevice(ctx context.Context, deviceUDID string) ([]*Profile, error) {
	// Try policy-based resolution first
	rows, err := db.QueryContext(ctx, `
		SELECT DISTINCT p.id, p.org_id, p.name, p.profile_identifier, p.profile_uuid,
		       p.profile_display_name, p.profile_payload, p.target_platforms, p.status
		FROM mdm_profiles p
		JOIN devices d ON d.org_id = p.org_id
		JOIN config_policy_feature_links fl ON fl.config_policy_id IN (
			SELECT cp.id FROM configuration_policies cp
			WHERE cp.org_id = d.org_id
			  AND (cp.site_id = d.site_id OR cp.site_id IS NULL)
		)
		JOIN config_policy_mdm_profile_settings mps ON mps.feature_link_id = fl.id
		WHERE d.mdm_udid = $1
		  AND p.status = 'active'
		  AND p.id = ANY(mps.profile_ids)
		ORDER BY p.created_at ASC
	`, deviceUDID)
	if err != nil {
		return nil, fmt.Errorf("policy-based profile resolution failed: %w", err)
	}
	defer rows.Close()

	var profiles []*Profile
	for rows.Next() {
		var p Profile
		var platforms []byte
		if err := rows.Scan(&p.ID, &p.OrgID, &p.Name, &p.Identifier, &p.UUID, &p.DisplayName, &p.Payload, &platforms, &p.Status); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(platforms, &p.TargetPlatforms); err != nil {
			p.TargetPlatforms = []string{"ios", "ipados", "macos"}
		}
		profiles = append(profiles, &p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// If policy-based resolution returned nothing, fall back to all active org profiles (lab mode)
	if len(profiles) == 0 {
		rows2, err := db.QueryContext(ctx, `
			SELECT p.id, p.org_id, p.name, p.profile_identifier, p.profile_uuid,
			       p.profile_display_name, p.profile_payload, p.target_platforms, p.status
			FROM mdm_profiles p
			JOIN devices d ON d.org_id = p.org_id
			WHERE d.mdm_udid = $1
			  AND p.status = 'active'
			ORDER BY p.created_at ASC
		`, deviceUDID)
		if err != nil {
			return nil, fmt.Errorf("fallback profile resolution failed: %w", err)
		}
		defer rows2.Close()

		for rows2.Next() {
			var p Profile
			var platforms []byte
			if err := rows2.Scan(&p.ID, &p.OrgID, &p.Name, &p.Identifier, &p.UUID, &p.DisplayName, &p.Payload, &platforms, &p.Status); err != nil {
				return nil, err
			}
			if err := json.Unmarshal(platforms, &p.TargetPlatforms); err != nil {
				p.TargetPlatforms = []string{"ios", "ipados", "macos"}
			}
			profiles = append(profiles, &p)
		}
		if err := rows2.Err(); err != nil {
			return nil, err
		}
	}

	return profiles, nil
}

// ─── APNs Config Storage ───

// APNsConfig holds the APNs configuration for an org.
type APNsConfig struct {
	OrgID        string
	CertPEM      []byte
	KeyPEM       []byte
	Topic        string
	UseTokenAuth bool
	CertExpiry   time.Time
	ABMEnabled   bool
	ABMToken     []byte
}

// GetAPNsConfig retrieves the APNs configuration for an org.
func (db *DB) GetAPNsConfig(ctx context.Context, orgID string) (*APNsConfig, error) {
	row := db.QueryRowContext(ctx, `
		SELECT apns_cert_encrypted, apns_key_encrypted, apns_topic,
		       apns_use_token_auth, apns_push_cert_expiry,
		       abm_enabled, abm_token_encrypted
		FROM mdm_apns_config
		WHERE org_id = $1
	`, orgID)

	var c APNsConfig
	c.OrgID = orgID
	var certExpiry sql.NullTime
	err := row.Scan(
		&c.CertPEM, &c.KeyPEM, &c.Topic,
		&c.UseTokenAuth, &certExpiry,
		&c.ABMEnabled, &c.ABMToken,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if certExpiry.Valid {
		c.CertExpiry = certExpiry.Time
	}
	return &c, nil
}

// ─── Helpers ───

func deviceOSType(product string) string {
	if len(product) >= 6 {
		switch product[:6] {
		case "iPhone":
			return "ios"
		case "iPad":
			return "ipados"
		case "MacBook", "iMac", "Macmini", "MacPro", "Mac":
			return "macos"
		}
	}
	return "ios"
}
