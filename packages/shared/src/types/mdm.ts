/**
 * MDM Module — Shared Types
 *
 * Types shared between the Breeze API, Web UI, and MDM sidecar service.
 * These define the shape of MDM profiles, commands, and device state
 * as they flow through the system.
 */

// ─── Device MDM State ───

export type MdmEnrollmentType = 'manual' | 'abm_ade' | 'user_enrollment';

export interface MdmDeviceInfo {
  /** Whether this device is enrolled in MDM */
  mdmEnrolled: boolean;
  /** Apple Unique Device ID */
  mdmUdId?: string;
  /** Device serial number (Apple-reported) */
  mdmSerialNumber?: string;
  /** Apple product identifier (e.g., "iPhone14,2", "MacBookPro18,1") */
  mdmProduct?: string;
  /** Human-readable model name (e.g., "iPhone 15 Pro") */
  mdmModelName?: string;
  /** Whether the device is supervised (ABM-enrolled) */
  mdmSupervised: boolean;
  /** Whether Activation Lock is enabled */
  mdmActivationLockEnabled: boolean;
  /** Last time the device checked in with the MDM server */
  mdmLastCheckin?: string;
  /** How the device enrolled */
  mdmEnrollmentType: MdmEnrollmentType;
}

// ─── MDM Profiles ───

export type MdmProfileStatus = 'draft' | 'active' | 'archived';

export type MdmTargetPlatform = 'ios' | 'ipados' | 'macos';

/**
 * A single Apple configuration profile payload.
 * Maps to a payload dictionary inside a .mobileconfig plist.
 */
export interface MdmProfilePayload {
  /** Apple payload type (e.g., "com.apple.wifi.managed") */
  type: string;
  /** Unique identifier for this payload within the profile */
  identifier: string;
  /** UUID for this payload */
  uuid: string;
  /** Display name */
  displayName?: string;
  /** Whether the user can remove this payload */
  removalDisallowed?: boolean;
  /** Payload-specific settings (varies by type) */
  settings: Record<string, unknown>;
}

/**
 * An MDM configuration profile — the Breeze-native representation
 * that gets serialized into a signed .mobileconfig for deployment.
 */
export interface MdmProfile {
  id: string;
  orgId: string;
  name: string;
  description?: string;
  status: MdmProfileStatus;
  /** Apple profile identifier (e.g., "com.company.wifi") */
  profileIdentifier: string;
  /** Apple profile UUID */
  profileUuid: string;
  /** Display name shown on the device */
  profileDisplayName: string;
  profileDescription?: string;
  profileOrganization?: string;
  profileRemovalDisallowed: boolean;
  /** The signed .mobileconfig XML */
  profilePayload: string;
  /** Structured payloads for UI editing */
  payloads: MdmProfilePayload[];
  /** Which platforms this profile targets */
  targetPlatforms: MdmTargetPlatform[];
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── MDM Commands ───

export type MdmCommandType =
  | 'install_profile'
  | 'remove_profile'
  | 'device_lock'
  | 'device_wipe'
  | 'clear_passcode'
  | 'restart_device'
  | 'shutdown_device'
  | 'os_update'
  | 'install_app'
  | 'remove_app'
  | 'device_information'
  | 'profile_list'
  | 'security_info'
  | 'certificate_list';

export type MdmCommandStatus =
  | 'pending'
  | 'queued'
  | 'sent'
  | 'acknowledged'
  | 'error'
  | 'failed'
  | 'timeout'
  | 'cancelled';

export interface MdmCommand {
  id: string;
  deviceId: string;
  commandType: MdmCommandType;
  commandUuid: string;
  status: MdmCommandStatus;
  payload?: Record<string, unknown>;
  resultPayload?: Record<string, unknown>;
  errorCode?: string;
  errorChain?: unknown[];
  createdAt: string;
  queuedAt?: string;
  sentAt?: string;
  acknowledgedAt?: string;
  expiresAt?: string;
  createdBy?: string;
}

/**
 * Request to send an MDM command to a device.
 */
export interface MdmCommandRequest {
  commandType: MdmCommandType;
  payload?: Record<string, unknown>;
}

// ─── MDM Profile Installation ───

export type MdmProfileInstallationStatus = 'pending' | 'installed' | 'failed' | 'removed' | 'verifying';

export interface MdmProfileInstallation {
  id: string;
  deviceId: string;
  profileId: string;
  profileUuid: string;
  installedAt?: string;
  verifiedAt?: string;
  status: MdmProfileInstallationStatus;
}

// ─── APNs / ABM Configuration ───

export interface MdmApnsConfig {
  id: string;
  orgId: string;
  /** Whether an APNs certificate has been uploaded (cert itself is encrypted) */
  hasCert: boolean;
  apnsTopic?: string;
  apnsPushCertExpiry?: string;
  /** Whether Apple Business Manager is linked */
  abmEnabled: boolean;
  abmLastSync?: string;
  /** Whether SCEP is enabled for device certificates */
  scepEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── Policy Integration ───

export interface ConfigPolicyMdmProfileSettings {
  id: string;
  featureLinkId: string;
  /** MDM profiles to enforce under this policy */
  profileIds: string[];
  /** Remove profiles not in the list */
  enforceExactSet: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── API Response Shapes ───

export interface MdmProfileListResponse {
  profiles: MdmProfile[];
  total: number;
  page: number;
  limit: number;
}

export interface MdmDeviceListResponse {
  devices: Array<{
    id: string;
    hostname: string;
    displayName?: string;
    osType: string;
    osVersion: string;
    status: string;
    mdm: MdmDeviceInfo;
  }>;
  total: number;
  page: number;
  limit: number;
}

export interface MdmCommandListResponse {
  commands: MdmCommand[];
  total: number;
}

// ─── Sidecar API Contracts ───
// These define the HTTP API between Breeze API and the MDM sidecar.

export interface SidecarQueueCommandRequest {
  device_udid: string;
  command_type: MdmCommandType;
  payload?: Record<string, unknown>;
  created_by?: string;
}

export interface SidecarQueueCommandResponse {
  command_id: string;
  status: string;
  message?: string;
}

export interface SidecarDeviceInfo {
  udid: string;
  mdm_enrolled: boolean;
  status: string;
  last_checkin?: string;
  supervised: boolean;
}
