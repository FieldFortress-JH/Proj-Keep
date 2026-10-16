import { db } from '../../db';
import { mdmApnsConfig } from '../../db/schema';
import { eq, lt } from 'drizzle-orm';
import { encryptSecret, decryptSecret } from '../secretCrypto';

/**
 * APNs Manager — handles Apple Push Notification service configuration.
 *
 * Each organization needs:
 *   - An APNs push certificate (from Apple Push Certificates Portal)
 *   - The certificate is encrypted at rest in mdm_apns_config (AES-256-GCM)
 *   - Annual renewal required (Apple push certs expire after 1 year)
 *
 * The actual APNs push sending is handled by the MDM sidecar (Go service).
 * This service manages the configuration and certificate lifecycle.
 */

// AAD binding for the APNs config columns — prevents ciphertext swapping
// between columns (mdm_apns_config.apns_cert_encrypted vs apns_key_encrypted).
const CERT_AAD = 'mdm_apns_config.apns_cert_encrypted';
const KEY_AAD = 'mdm_apns_config.apns_key_encrypted';
const ABM_TOKEN_AAD = 'mdm_apns_config.abm_token_encrypted';

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
 * Store an APNs certificate (encrypted at rest with AES-256-GCM).
 *
 * The cert PEM and key PEM are encrypted using the app's secret encryption
 * key (encryptSecret) with AAD binding to prevent ciphertext swapping
 * between columns.
 */
export async function storeApnsCertificate(
  orgId: string,
  certPem: string,
  keyPem: string | undefined,
  topic: string,
  expiry: Date,
) {
  // Encrypt cert and key with AAD binding
  const encryptedCert = encryptSecret(certPem, { aad: CERT_AAD }) ?? certPem;
  const encryptedKey = keyPem ? (encryptSecret(keyPem, { aad: KEY_AAD }) ?? keyPem) : null;

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
 * Retrieve and decrypt the APNs certificate for an org.
 * Used by the sidecar client to pass certs to the Go sidecar.
 */
export async function getDecryptedApnsCertificate(orgId: string): Promise<{
  certPem: string | null;
  keyPem: string | null;
  topic: string | null;
  expiry: Date | null;
} | null> {
  const [config] = await db
    .select()
    .from(mdmApnsConfig)
    .where(eq(mdmApnsConfig.orgId, orgId))
    .limit(1);

  if (!config || !config.apnsCertEncrypted) {
    return null;
  }

  return {
    certPem: decryptSecret(config.apnsCertEncrypted, { aad: CERT_AAD }),
    keyPem: config.apnsKeyEncrypted
      ? decryptSecret(config.apnsKeyEncrypted, { aad: KEY_AAD })
      : null,
    topic: config.apnsTopic,
    expiry: config.apnsPushCertExpiry,
  };
}

/**
 * Store an ABM (Apple Business Manager) token (encrypted at rest).
 */
export async function storeAbmToken(
  orgId: string,
  tokenEncrypted: string,
  tokenExpiry: Date,
) {
  const encrypted = encryptSecret(tokenEncrypted, { aad: ABM_TOKEN_AAD }) ?? tokenEncrypted;

  const [config] = await db
    .insert(mdmApnsConfig)
    .values({
      orgId,
      abmTokenEncrypted: encrypted,
      abmTokenExpiry: tokenExpiry,
      abmEnabled: true,
    })
    .onConflictDoUpdate({
      target: mdmApnsConfig.orgId,
      set: {
        abmTokenEncrypted: encrypted,
        abmTokenExpiry: tokenExpiry,
        abmEnabled: true,
        updatedAt: new Date(),
      },
    })
    .returning();

  return config;
}

/**
 * Retrieve and decrypt the ABM token for an org.
 */
export async function getDecryptedAbmToken(orgId: string): Promise<string | null> {
  const [config] = await db
    .select()
    .from(mdmApnsConfig)
    .where(eq(mdmApnsConfig.orgId, orgId))
    .limit(1);

  if (!config || !config.abmTokenEncrypted) {
    return null;
  }

  return decryptSecret(config.abmTokenEncrypted, { aad: ABM_TOKEN_AAD });
}

/**
 * Check all orgs for APNs certificates nearing expiry.
 * Returns orgs that need renewal alerts.
 *
 * Uses proper SQL date comparison (lt) instead of in-memory filtering.
 */
export async function findExpiringCertificates(daysThreshold = 30) {
  const threshold = new Date(Date.now() + daysThreshold * 24 * 60 * 60 * 1000);

  const expiring = await db
    .select()
    .from(mdmApnsConfig)
    .where(lt(mdmApnsConfig.apnsPushCertExpiry, threshold));

  return expiring;
}

/**
 * Update the last ABM sync timestamp for an org.
 */
export async function updateAbmLastSync(orgId: string) {
  await db
    .update(mdmApnsConfig)
    .set({ abmLastSync: new Date(), updatedAt: new Date() })
    .where(eq(mdmApnsConfig.orgId, orgId));
}
