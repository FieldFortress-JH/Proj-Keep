import { db } from '../../db';
import { devices, mdmApnsConfig } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { AuthContext } from '../../middleware/auth';

/**
 * Enrollment — handles MDM device enrollment flows.
 *
 * Two enrollment paths:
 *   1. Manual — user downloads .mobileconfig from sidecar /mdm/enroll
 *   2. ABM/ADE — zero-touch via Apple Business Manager (Phase 3)
 */

export interface EnrollmentToken {
  token: string;
  orgId: string;
  siteId?: string;
  enrollmentType: 'manual' | 'abm_ade' | 'user_enrollment';
  expiresAt: Date;
  createdAt: Date;
}

// In-memory token store (replace with Redis in production)
const enrollmentTokens = new Map<string, EnrollmentToken>();

/**
 * Generate an enrollment token for manual enrollment.
 */
export function generateEnrollmentToken(
  auth: AuthContext,
  siteId?: string,
  enrollmentType: 'manual' | 'abm_ade' | 'user_enrollment' = 'manual',
): EnrollmentToken {
  const token = randomUUID();
  const enrollment: EnrollmentToken = {
    token,
    orgId: auth.orgId!,
    siteId,
    enrollmentType,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
    createdAt: new Date(),
  };

  enrollmentTokens.set(token, enrollment);

  // Clean up expired tokens
  setTimeout(() => enrollmentTokens.delete(token), 60 * 60 * 1000);

  return enrollment;
}

/**
 * Validate an enrollment token.
 */
export function validateEnrollmentToken(token: string): EnrollmentToken | null {
  const enrollment = enrollmentTokens.get(token);
  if (!enrollment || enrollment.expiresAt < new Date()) {
    return null;
  }
  return enrollment;
}

/**
 * Get the enrollment URL for the sidecar.
 * This is the URL users visit (or QR code data) to download the .mobileconfig.
 *
 * The token is included in the URL (the sidecar uses it to identify the org).
 */
export function getEnrollmentUrl(token: string, sidecarBaseUrl?: string): string {
  const base = sidecarBaseUrl || process.env.MDM_SIDECAR_PUBLIC_URL || 'https://mdm.breeze.lan';
  const enrollment = validateEnrollmentToken(token);
  const orgId = enrollment?.orgId || '';
  return `${base}/mdm/enroll?token=***}&org_id=${encodeURIComponent(orgId)}`;
}

/**
 * Register a newly enrolled MDM device.
 * Called when a device first checks in via the sidecar.
 */
export async function registerMdmDevice(
  orgId: string,
  siteId: string,
  deviceInfo: {
    udid: string;
    serialNumber?: string;
    product?: string;
    modelName?: string;
    osType: 'ios' | 'ipados' | 'macos';
    osVersion: string;
    supervised?: boolean;
    enrollmentType: 'manual' | 'abm_ade' | 'user_enrollment';
  },
  enrolledBy?: string,
) {
  // Check if device already exists (by mdm_udid)
  const [existing] = await db
    .select()
    .from(devices)
    .where(eq(devices.mdmUdId, deviceInfo.udid))
    .limit(1);

  if (existing) {
    // Update existing device with MDM info
    const [updated] = await db
      .update(devices)
      .set({
        mdmEnrolled: true,
        mdmUdId: deviceInfo.udid,
        mdmSerialNumber: deviceInfo.serialNumber,
        mdmProduct: deviceInfo.product,
        mdmModelName: deviceInfo.modelName,
        mdmSupervised: deviceInfo.supervised ?? false,
        mdmLastCheckin: new Date(),
        mdmEnrollmentType: deviceInfo.enrollmentType,
        status: 'online',
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(devices.id, existing.id))
      .returning();

    return updated;
  }

  // Create new device record for MDM-only device (no agent)
  const [device] = await db
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `mdm-${deviceInfo.udid}`, // Synthetic agent ID for MDM devices
      hostname: deviceInfo.modelName || deviceInfo.udid,
      displayName: deviceInfo.modelName,
      osType: deviceInfo.osType,
      osVersion: deviceInfo.osVersion,
      architecture: 'arm64', // Apple Silicon default; refine from product
      agentVersion: 'mdm-1.0',
      status: 'online',
      mdmEnrolled: true,
      mdmUdId: deviceInfo.udid,
      mdmSerialNumber: deviceInfo.serialNumber,
      mdmProduct: deviceInfo.product,
      mdmModelName: deviceInfo.modelName,
      mdmSupervised: deviceInfo.supervised ?? false,
      mdmLastCheckin: new Date(),
      mdmEnrollmentType: deviceInfo.enrollmentType,
      enrolledBy,
      lastSeenAt: new Date(),
    })
    .returning();

  return device;
}

/**
 * Update device MDM check-in timestamp.
 */
export async function updateMdmCheckin(deviceId: string) {
  await db
    .update(devices)
    .set({
      mdmLastCheckin: new Date(),
      lastSeenAt: new Date(),
      status: 'online',
      updatedAt: new Date(),
    })
    .where(eq(devices.id, deviceId));
}

/**
 * Get APNs config for an org.
 */
export async function getApnsConfig(orgId: string) {
  const [configRow] = await db
    .select()
    .from(mdmApnsConfig)
    .where(eq(mdmApnsConfig.orgId, orgId))
    .limit(1);

  return configRow || null;
}
