-- MDM Module Foundation — Wave 1: schema for native Apple MDM in Breeze.
--
-- Spec: documents/breeze/mdm-module-architecture.md
--
-- Extends the existing devices table with MDM tracking columns, adds the
-- os_type values for iOS/iPadOS, and creates the MDM profile/command/APNs
-- tables. Also extends config_feature_type with 'mdm_profile' so MDM
-- profiles can be assigned through the existing Configuration Policies
-- system.
--
-- DDL only: no INSERT/UPDATE/DELETE, so no set_config('breeze.scope', ...)
-- preamble. Idempotent.
--
-- Rollback: a new migration dropping the new tables and columns.

-- =====================================================================
-- 1. Extend os_type enum with Apple mobile platforms
-- =====================================================================

ALTER TYPE os_type ADD VALUE IF NOT EXISTS 'ios';
ALTER TYPE os_type ADD VALUE IF NOT EXISTS 'ipados';

-- =====================================================================
-- 2. Extend devices table with MDM tracking columns
-- =====================================================================

ALTER TABLE devices ADD COLUMN IF NOT EXISTS mdm_enrolled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS mdm_udid VARCHAR(255);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS mdm_serial_number VARCHAR(255);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS mdm_product VARCHAR(255);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS mdm_model_name VARCHAR(255);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS mdm_supervised BOOLEAN DEFAULT false;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS mdm_activation_lock_enabled BOOLEAN DEFAULT false;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS mdm_last_checkin TIMESTAMPTZ;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS mdm_enrollment_type VARCHAR(50) DEFAULT 'manual';
-- manual | abm_ade | user_enrollment

-- Index for MDM device lookups
CREATE INDEX IF NOT EXISTS devices_mdm_enrolled_idx ON devices(mdm_enrolled) WHERE mdm_enrolled = true;
CREATE INDEX IF NOT EXISTS devices_mdm_udid_idx ON devices(mdm_udid) WHERE mdm_udid IS NOT NULL;

-- =====================================================================
-- 3. mdm_profiles — Apple configuration profiles (.mobileconfig)
-- =====================================================================

CREATE TYPE mdm_profile_status AS ENUM ('draft', 'active', 'archived');

CREATE TABLE IF NOT EXISTS mdm_profiles (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id),
  name                varchar(255) NOT NULL,
  description         text,
  status              mdm_profile_status NOT NULL DEFAULT 'draft',
  -- Apple profile identity
  profile_identifier  varchar(255) NOT NULL,
  profile_uuid        uuid NOT NULL DEFAULT gen_random_uuid(),
  profile_display_name varchar(255) NOT NULL,
  profile_description text,
  profile_organization varchar(255),
  profile_removal_disallowed boolean DEFAULT false,
  -- The signed .mobileconfig XML (signed at creation time)
  profile_payload     text NOT NULL DEFAULT '',
  -- Breeze-native structured payloads for UI editing (JSON array)
  payloads            jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Target platforms: ios, ipados, macos
  target_platforms    text[] NOT NULL DEFAULT '{ios,ipados,macos}',
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mdm_profiles_org_idx ON mdm_profiles(org_id);
CREATE INDEX IF NOT EXISTS mdm_profiles_identifier_idx ON mdm_profiles(profile_identifier);
CREATE INDEX IF NOT EXISTS mdm_profiles_status_idx ON mdm_profiles(status);

-- =====================================================================
-- 4. mdm_profile_installations — tracks which profiles are on which devices
-- =====================================================================

CREATE TABLE IF NOT EXISTS mdm_profile_installations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id       uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  profile_id      uuid NOT NULL REFERENCES mdm_profiles(id) ON DELETE CASCADE,
  profile_uuid    uuid NOT NULL,  -- copied from profile for immutability
  installed_at    timestamptz,
  verified_at     timestamptz,    -- last time device confirmed installation
  status          varchar(50) NOT NULL DEFAULT 'pending'
  -- pending | installed | failed | removed | verifying
);

CREATE INDEX IF NOT EXISTS mdm_profile_installations_device_idx ON mdm_profile_installations(device_id);
CREATE INDEX IF NOT EXISTS mdm_profile_installations_profile_idx ON mdm_profile_installations(profile_id);
CREATE UNIQUE INDEX IF NOT EXISTS mdm_profile_installations_device_profile_uniq
  ON mdm_profile_installations(device_id, profile_id);

-- =====================================================================
-- 5. mdm_commands — queued MDM commands with status tracking
-- =====================================================================

CREATE TYPE mdm_command_type AS ENUM (
  'install_profile',
  'remove_profile',
  'device_lock',
  'device_wipe',
  'clear_passcode',
  'restart_device',
  'shutdown_device',
  'os_update',
  'install_app',
  'remove_app',
  'device_information',
  'profile_list',
  'security_info',
  'certificate_list'
);

CREATE TYPE mdm_command_status AS ENUM (
  'pending',
  'queued',
  'sent',
  'acknowledged',
  'error',
  'failed',
  'timeout',
  'cancelled'
);

CREATE TABLE IF NOT EXISTS mdm_commands (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id       uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  command_type    mdm_command_type NOT NULL,
  command_uuid    uuid NOT NULL DEFAULT gen_random_uuid(),
  status          mdm_command_status NOT NULL DEFAULT 'pending',
  -- Apple MDM command payload (XML/plist structure as JSON)
  payload         jsonb,
  -- Device response
  result_payload  jsonb,
  error_code      varchar(50),
  error_chain     jsonb,
  -- Timing
  created_at      timestamptz NOT NULL DEFAULT now(),
  queued_at       timestamptz,
  sent_at         timestamptz,
  acknowledged_at timestamptz,
  expires_at      timestamptz,
  created_by      uuid REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS mdm_commands_device_idx ON mdm_commands(device_id);
CREATE INDEX IF NOT EXISTS mdm_commands_status_idx ON mdm_commands(status);
CREATE INDEX IF NOT EXISTS mdm_commands_device_status_idx ON mdm_commands(device_id, status);

-- =====================================================================
-- 6. mdm_apns_config — APNs push certificate and ABM configuration per org
-- =====================================================================

CREATE TABLE IF NOT EXISTS mdm_apns_config (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id),
  -- APNs certificate (encrypted at rest)
  apns_cert_encrypted text,
  apns_key_encrypted  text,
  apns_topic          varchar(255),
  apns_use_token_auth boolean DEFAULT false,
  apns_push_cert_expiry timestamptz,
  -- Apple Business Manager
  abm_token_encrypted text,
  abm_token_expiry    timestamptz,
  abm_enabled         boolean DEFAULT false,
  abm_last_sync       timestamptz,
  -- SCEP configuration for device certificates
  scep_enabled        boolean DEFAULT false,
  scep_ca_fingerprint varchar(255),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mdm_apns_config_org_unique UNIQUE (org_id)
);

-- =====================================================================
-- 7. Extend config_feature_type enum with mdm_profile
-- =====================================================================

ALTER TYPE config_feature_type ADD VALUE IF NOT EXISTS 'mdm_profile';

-- =====================================================================
-- 8. config_policy_mdm_profile_settings — links MDM profiles to policies
-- =====================================================================

CREATE TABLE IF NOT EXISTS config_policy_mdm_profile_settings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_link_id uuid NOT NULL UNIQUE REFERENCES config_policy_feature_links(id) ON DELETE CASCADE,
  -- Which MDM profiles to enforce under this policy
  profile_ids     uuid[] NOT NULL DEFAULT '{}',
  -- Remove profiles not in the list?
  enforce_exact_set boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS config_policy_mdm_profile_settings_feature_link_idx
  ON config_policy_mdm_profile_settings(feature_link_id);
