import { db } from '../../db';
import { mdmApnsConfig } from '../../db/schema';
import { eq } from 'drizzle-orm';

/**
 * APNs Manager — handles Apple Push Notification service configuration.
 *
 * Each organization needs:
 *   - An APNs push certificate (from Apple Push Certificates Portal)
 *   - The certificate is encrypted at rest in mdm_apns_config
 *   - Annual renewal required (Apple push certs expire after 1 year)
 *
 * The actual APNs push sending is handled by the MDM sidecar (Go service).
 * This service manages the configuration and certificate lifecycle.
 */

export interface ApnsConfigStatus {
  configured: boolean;
  certExpiry?: Date;
  daysUntilExpiry?: number;
  needsRenewal: boolean;
  abmEnabled: boolean;
  abmLastSync?: Date;
  scepEnabled: boolean;
}

/**
 * Get the APNs configuration status for an org (without exposing the cert).
 */
export async function getApnsConfigStatus(orgId: string): Promise<ApnsConfigStatus> {
  const [config] = await db
    .select()
    .from(mdmApnsConfig)
    .where(eq(mdmApnsConfig.orgId, orgId))
    .limit(1);

  if (!config || !config.apnsCertEncrypted) {
    return {
      configured: false,
      needsRenewal: false,
      abmEnabled: false,
      scepEnabled: false,
    };
  }

  const daysUntilExpiry = config.apnsPushCertExpiry
    ? Math.ceil((config.apnsPushCertExpiry.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
    : undefined;

  return {
    configured: true,
    certExpiry: config.apnsPushCertExpiry ?? undefined,
    daysUntilExpiry,
    needsRenewal: daysUntilExpiry !== undefined && daysUntilExpiry < 30,
    abmEnabled: config.abmEnabled,
    abmLastSync: config.abmLastSync ?? undefined,
    scepEnabled: config.scepEnabled,
  };
}

/**
 * Store an APNs certificate (encrypted).
 * TODO: Implement encryption using the org's encryption key.
 */
export async function storeApnsCertificate(
  orgId: string,
  certPem: string,
  keyPem: string | undefined,
  topic: string,
  expiry: Date,
) {
  // TODO: Encrypt certPem and keyPem before storing
  const encryptedCert = certPem; // Placeholder — encrypt in production
  const encryptedKey = keyPem;

  const [config] = await db
    .insert(mdmApnsConfig)
    .values({
      orgId,
      apnsCertEncrypted: encryptedCert,
      apnsKeyEncrypted: encryptedKey,
      apnsTopic: topic,
      apnsPushCertExpiry: expiry,
    })
    .onConflictDoUpdate({
      target: mdmApnsConfig.orgId,
      set: {
        apnsCertEncrypted: encryptedCert,
        apnsKeyEncrypted: encryptedKey,
        apnsTopic: topic,
        apnsPushCertExpiry: expiry,
        updatedAt: new Date(),
      },
    })
    .returning();

  return config;
}

/**
 * Check all orgs for APNs certificates nearing expiry.
 * Returns orgs that need renewal alerts.
 */
export async function findExpiringCertificates(daysThreshold = 30) {
  const threshold = new Date(Date.now() + daysThreshold * 24 * 60 * 60 * 1000);

  const expiring = await db
    .select()
    .from(mdmApnsConfig)
    .where(eq(mdmApnsConfig.apnsPushCertExpiry, threshold));

  // TODO: Proper date comparison — use lt/gte from drizzle
  return expiring.filter(
    (c) => c.apnsPushCertExpiry && c.apnsPushCertExpiry <= threshold,
  );
}
