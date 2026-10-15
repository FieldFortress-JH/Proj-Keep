// Package storage implements NanoMDM's storage interfaces backed by PostgreSQL.
// This connects the MDM sidecar to the same database Breeze uses, so MDM
// devices, commands, and profiles are all in one place.
package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

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
		SELECT id, mdm_udid, mdm_serial_number, org_id, enrolled_at,
		       mdm_last_checkin, mdm_supervised, mdm_activation_lock_enabled,
		       os_version, mdm_product, mdm_model_name, mdm_enrollment_type
		FROM devices
		WHERE mdm_udid = $1 AND mdm_enrolled = true
		LIMIT 1
	`, udid)

	var d Device
	var lastCheckin sql.NullTime
	err := row.Scan(
		&d.ID, &d.UDID, &d.SerialNumber, &d.OrgID, &d.EnrolledAt,
		&lastCheckin, &d.Supervised, &d.ActivationLock,
		&d.OSVersion, &d.Product, &d.ModelName, &d.EnrollmentType,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if lastCheckin.Valid {
		d.LastCheckin = lastCheckin.Time
	}
	return &d, nil
}

// UpsertDevice creates or updates a device record.
func (db *DB) UpsertDevice(ctx context.Context, d *Device) error {
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
		d.ID, d.OrgID, "00000000-0000-0000-0000-000000000000", // TODO: real site_id
		"mdm-"+d.UDID, d.ModelName, deviceOSType(d.Product), d.OSVersion,
		"arm64", "mdm-1.0", "online", d.UDID,
		d.SerialNumber, d.Product, d.ModelName, d.Supervised,
		d.ActivationLock, d.LastCheckin, d.EnrollmentType,
		d.LastCheckin, d.EnrolledAt,
	)
	return err
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

// ListDevicesByOrg lists all MDM-enrolled devices for an organization.
func (db *DB) ListDevicesByOrg(ctx context.Context, orgID string) ([]*Device, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT id, mdm_udid, mdm_serial_number, org_id, enrolled_at,
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
		var lastCheckin sql.NullTime
		if err := rows.Scan(
			&d.ID, &d.UDID, &d.SerialNumber, &d.OrgID, &d.EnrolledAt,
			&lastCheckin, &d.Supervised, &d.ActivationLock,
			&d.OSVersion, &d.Product, &d.ModelName, &d.EnrollmentType,
		); err != nil {
			return nil, err
		}
		if lastCheckin.Valid {
			d.LastCheckin = lastCheckin.Time
		}
		devices = append(devices, &d)
	}
	return devices, rows.Err()
}

// ─── Command Storage ───

// Command represents an MDM command in storage.
type Command struct {
	ID         string          `json:"id"`
	DeviceUDID string          `json:"device_udid"`
	CommandUUID string         `json:"command_uuid"`
	Type       string          `json:"type"`
	Status     string          `json:"status"`
	Payload    json.RawMessage `json:"payload,omitempty"`
	Result     json.RawMessage `json:"result,omitempty"`
	ErrorCode  string          `json:"error_code,omitempty"`
	CreatedAt  time.Time       `json:"created_at"`
	SentAt     *time.Time      `json:"sent_at,omitempty"`
	CompletedAt *time.Time     `json:"completed_at,omitempty"`
}

// QueueCommand adds a command to the queue for a device.
func (db *DB) QueueCommand(ctx context.Context, deviceUDID, commandType string, payload json.RawMessage) (*Command, error) {
	cmdUUID := generateUUID()

	_, err := db.ExecContext(ctx, `
		INSERT INTO mdm_commands (
			device_id, command_type, command_uuid, status, payload, created_at, expires_at
		)
		SELECT d.id, $1, $2, 'queued', $3, now(), now() + interval '24 hours'
		FROM devices d
		WHERE d.mdm_udid = $4 AND d.mdm_enrolled = true
	`, commandType, cmdUUID, payload, deviceUDID)
	if err != nil {
		return nil, fmt.Errorf("failed to queue command: %w", err)
	}

	return &Command{
		CommandUUID: cmdUUID,
		DeviceUDID:  deviceUDID,
		Type:        commandType,
		Status:      "queued",
		Payload:     payload,
		CreatedAt:   time.Now(),
	}, nil
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
		if err := rows.Scan(&c.ID, &c.CommandUUID, &c.Type, &c.Status, &c.Payload, &c.CreatedAt); err != nil {
			return nil, err
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
	ID               string          `json:"id"`
	OrgID            string          `json:"org_id"`
	Name             string          `json:"name"`
	Identifier       string          `json:"identifier"`
	UUID             string          `json:"uuid"`
	DisplayName      string          `json:"display_name"`
	Payload          string          `json:"payload"` // Signed .mobileconfig XML
	TargetPlatforms  []string        `json:"target_platforms"`
	Status           string          `json:"status"`
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
// based on the device's org and assigned configuration policies.
func (db *DB) GetProfilesForDevice(ctx context.Context, deviceUDID string) ([]*Profile, error) {
	// TODO: Resolve via config_policy_mdm_profile_settings → device's assigned policies
	// For now, return all active profiles for the device's org
	rows, err := db.QueryContext(ctx, `
		SELECT p.id, p.org_id, p.name, p.profile_identifier, p.profile_uuid,
		       p.profile_display_name, p.profile_payload, p.target_platforms, p.status
		FROM mdm_profiles p
		JOIN devices d ON d.org_id = p.org_id
		WHERE d.mdm_udid = $1
		  AND p.status = 'active'
	`, deviceUDID)
	if err != nil {
		return nil, err
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
	return profiles, rows.Err()
}

// ─── APNs Config Storage ───

// APNsConfig holds the APNs configuration for an org.
type APNsConfig struct {
	OrgID         string
	CertPEM       []byte
	KeyPEM        []byte
	Topic         string
	UseTokenAuth  bool
	CertExpiry    time.Time
	ABMEnabled    bool
	ABMToken      []byte
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

func generateUUID() string {
	// Simple UUID v4 generation
	b := make([]byte, 16)
	for i := range b {
		b[i] = byte(time.Now().UnixNano() >> (i % 8))
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
