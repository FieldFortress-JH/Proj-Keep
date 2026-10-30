import { db } from '../../db';
import { mdmProfiles, mdmProfileInstallations, devices } from '../../db/schema';
import { eq, and, desc, ilike, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { AuthContext } from '../../middleware/auth';
import type { MdmProfilePayload, MdmTargetPlatform } from '@breeze/shared';

/**
 * Profile Manager — CRUD operations for MDM configuration profiles.
 *
 * Profiles are stored in two forms:
 *   1. Structured payloads (JSONB) — for UI editing
 *   2. Signed .mobileconfig XML (text) — for deployment to devices
 *
 * The signing happens at activation time (when status changes to 'active').
 */

export interface CreateMdmProfileInput {
  orgId: string;
  name: string;
  description?: string;
  profileIdentifier: string;
  profileDisplayName: string;
  profileDescription?: string;
  profileOrganization?: string;
  profileRemovalDisallowed?: boolean;
  payloads: MdmProfilePayload[];
  targetPlatforms: MdmTargetPlatform[];
  createdBy?: string;
}

export interface UpdateMdmProfileInput {
  name?: string;
  description?: string;
  status?: 'draft' | 'active' | 'archived';
  profileDisplayName?: string;
  profileDescription?: string;
  profileOrganization?: string;
  profileRemovalDisallowed?: boolean;
  payloads?: MdmProfilePayload[];
  targetPlatforms?: MdmTargetPlatform[];
}

export interface ListMdmProfilesFilters {
  status?: string;
  search?: string;
  platform?: string;
}

/**
 * List MDM profiles for an organization.
 * Scoped to the caller's org via RLS context. Supports filtering by status,
 * platform, and full-text search on name/identifier.
 */
export async function listMdmProfiles(
  auth: AuthContext,
  filters: ListMdmProfilesFilters,
  pagination: { page: number; limit: number },
) {
  const conditions = [eq(mdmProfiles.orgId, auth.orgId!)];

  if (filters.status) {
    conditions.push(eq(mdmProfiles.status, filters.status as 'draft' | 'active' | 'archived'));
  }

  if (filters.search) {
    const searchPattern = `%${filters.search}%`;
    conditions.push(
      or(
        ilike(mdmProfiles.name, searchPattern),
        ilike(mdmProfiles.profileIdentifier, searchPattern),
        ilike(mdmProfiles.profileDisplayName, searchPattern),
      )!,
    );
  }

  if (filters.platform) {
    conditions.push(
      sql`${mdmProfiles.targetPlatforms} @> ARRAY[${filters.platform}]::text[]`
    );
  }

  // Get total count for pagination
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(mdmProfiles)
    .where(and(...conditions));

  const results = await db
    .select()
    .from(mdmProfiles)
    .where(and(...conditions))
    .orderBy(desc(mdmProfiles.createdAt))
    .limit(pagination.limit)
    .offset((pagination.page - 1) * pagination.limit);

  return {
    profiles: results,
    total: count,
    page: pagination.page,
    limit: pagination.limit,
  };
}

/**
 * Get a single MDM profile by ID.
 * Scoped to the caller's org.
 */
export async function getMdmProfile(auth: AuthContext, profileId: string) {
  const [profile] = await db
    .select()
    .from(mdmProfiles)
    .where(and(eq(mdmProfiles.id, profileId), eq(mdmProfiles.orgId, auth.orgId!)))
    .limit(1);

  if (!profile) {
    throw new Error('Profile not found');
  }

  return profile;
}

/**
 * Create a new MDM profile.
 * Generates a UUID for the profile and sets initial status to 'draft'.
 */
export async function createMdmProfile(auth: AuthContext, input: CreateMdmProfileInput) {
  // Ensure each payload has a UUID
  const payloadsWithUuids = input.payloads.map((p) => ({
    ...p,
    uuid: p.uuid || randomUUID(),
  }));

  const [profile] = await db
    .insert(mdmProfiles)
    .values({
      orgId: input.orgId,
      name: input.name,
      description: input.description,
      status: 'draft',
      profileIdentifier: input.profileIdentifier,
      profileDisplayName: input.profileDisplayName,
      profileDescription: input.profileDescription,
      profileOrganization: input.profileOrganization,
      profileRemovalDisallowed: input.profileRemovalDisallowed ?? false,
      payloads: payloadsWithUuids,
      targetPlatforms: input.targetPlatforms,
      createdBy: input.createdBy,
    })
    .returning();

  return profile;
}

/**
 * Update an MDM profile.
 * Scoped to the caller's org. If payloads are updated, new UUIDs are
 * generated for payloads that don't have one.
 */
export async function updateMdmProfile(auth: AuthContext, profileId: string, input: UpdateMdmProfileInput) {
  const updateData: Record<string, unknown> = {
    ...input,
    updatedAt: new Date(),
  };

  // Ensure payload UUIDs if payloads are being updated
  if (input.payloads) {
    updateData.payloads = input.payloads.map((p) => ({
      ...p,
      uuid: p.uuid || randomUUID(),
    }));
  }

  const [updated] = await db
    .update(mdmProfiles)
    .set(updateData)
    .where(and(eq(mdmProfiles.id, profileId), eq(mdmProfiles.orgId, auth.orgId!)))
    .returning();

  if (!updated) {
    throw new Error('Profile not found');
  }

  return updated;
}

/**
 * Sign and activate a profile — generates the .mobileconfig XML.
 *
 * Signing: In production, profiles should be signed with the org's signing
 * certificate (CMS/PKCS#7). For the lab, we generate an unsigned .mobileconfig
 * which Apple devices will accept with a warning. When a signing cert is
 * configured (mdm_signing_certs table), the profile will be CMS-signed.
 *
 * TODO (Phase 3): Implement CMS signing with org's certificate:
 *   1. Look up org's signing cert from mdm_signing_certs
 *   2. Sign the .mobileconfig with the cert (openssl cms -sign)
 *   3. Store signed blob in profilePayload
 */
export async function signMdmProfile(auth: AuthContext, profileId: string) {
  const profile = await getMdmProfile(auth, profileId);

  // Generate the .mobileconfig XML from the structured payloads
  const mobileconfig = buildMobileconfig(profile);

  // NOTE: Unsigned for lab. Production signing requires the org's signing cert.
  // When implemented, replace profilePayload with the CMS-signed blob.

  const [updated] = await db
    .update(mdmProfiles)
    .set({
      profilePayload: mobileconfig,
      status: 'active',
      updatedAt: new Date(),
    })
    .where(eq(mdmProfiles.id, profileId))
    .returning();

  return updated;
}

/**
 * Archive a profile (soft delete).
 */
export async function archiveMdmProfile(auth: AuthContext, profileId: string) {
  return updateMdmProfile(auth, profileId, { status: 'archived' });
}

// ─── .mobileconfig XML Builder ───

/**
 * Build a .mobileconfig XML string from a profile's structured payloads.
 * Produces a valid Apple configuration profile plist.
 */
function buildMobileconfig(profile: typeof mdmProfiles.$inferSelect): string {
  const payloadsXml = (profile.payloads as MdmProfilePayload[])
    .map((p) => buildPayloadXml(p))
    .join('\n\t\t');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>PayloadContent</key>
	<array>
		${payloadsXml}
	</array>
	<key>PayloadDisplayName</key>
	<string>${escapeXml(profile.profileDisplayName)}</string>
	<key>PayloadIdentifier</key>
	<string>${escapeXml(profile.profileIdentifier)}</string>
	<key>PayloadType</key>
	<string>Configuration</string>
	<key>PayloadUUID</key>
	<string>${profile.profileUuid}</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
	<key>PayloadRemovalDisallowed</key>
	<${profile.profileRemovalDisallowed ? 'true' : 'false'}/>
	<key>PayloadScope</key>
	<string>System</string>
</dict>
</plist>`;
}

/**
 * Build a single payload's XML representation.
 *
 * Supports common Apple payload types with proper key mappings.
 * Unknown payload types fall back to a generic dict structure.
 *
 * Supported payload types (Phase 1b):
 *   - com.apple.wifi.managed (WiFi configuration)
 *   - com.apple.mobiledevice.passwordpolicy (Passcode policy)
 *   - com.apple.application.access (App restrictions)
 *   - com.apple.systempreferences (System preferences, macOS)
 *   - com.apple.security.pem (Certificate payload)
 *   - com.apple.vpn.managed (VPN configuration)
 *   - com.apple.webclip.managed (Web clip)
 *   - com.apple.softwareupdate.enforcement (OS update enforcement)
 *
 * TODO (Phase 2): Add remaining payload types:
 *   - com.apple.security.scep (SCEP)
 *   - com.apple.appstore (App Store restrictions)
 *   - com.appleiap (In-app purchase)
 *   - com.apple.managedapp.singleapp (Kiosk mode)
 *   - com.apple.font (Custom fonts)
 *   - com.apple.dock (Dock configuration)
 */
function buildPayloadXml(payload: MdmProfilePayload): string {
  // Build payload-specific content based on type
  const payloadContent = buildPayloadContent(payload);

  return `<dict>
			<key>PayloadType</key>
			<string>${escapeXml(payload.type)}</string>
			<key>PayloadIdentifier</key>
			<string>${escapeXml(payload.identifier)}</string>
			<key>PayloadUUID</key>
			<string>${payload.uuid || randomUUID()}</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
			<key>PayloadDisplayName</key>
			<string>${escapeXml(payload.displayName || payload.identifier)}</string>
			<key>PayloadEnabled</key>
			<true/>
			<key>PayloadContent</key>
			${payloadContent}
		</dict>`;
}

/**
 * Build the PayloadContent dict/array for a specific payload type.
 * Returns the inner XML for the PayloadContent key.
 */
function buildPayloadContent(payload: MdmProfilePayload): string {
  const settings = payload.settings || {};

  switch (payload.type) {
    case 'com.apple.wifi.managed':
      return buildWifiPayload(settings);

    case 'com.apple.mobiledevice.passwordpolicy':
      return buildPasscodePolicyPayload(settings);

    case 'com.apple.application.access':
      return buildAppRestrictionsPayload(settings);

    case 'com.apple.security.pem':
      return buildCertificatePayload(settings);

    case 'com.apple.vpn.managed':
      return buildVpnPayload(settings);

    case 'com.apple.webclip.managed':
      return buildWebClipPayload(settings);

    case 'com.apple.softwareupdate.enforcement':
      return buildSoftwareUpdatePayload(settings);

    case 'com.apple.systempreferences':
      return buildSystemPreferencesPayload(settings);

    default:
      // Generic fallback: emit all settings as a flat dict
      return buildGenericPayloadContent(settings);
  }
}

// ─── Payload Type Builders ───

function buildWifiPayload(s: Record<string, unknown>): string {
  // WiFi payload: SSID, security type, password
  const ssid = s.SSID_STR || s.ssid || '';
  const securityType = s.WIFI_SECURITY_TYPE || s.securityType || 'WPA2';
  const password = s.WIFI_PASSWORD || s.password || '';
  const hidden = s.HIDDEN_NETWORK === true || s.hidden === true;

  let securityDict = '';
  if (securityType === 'WPA2' || securityType === 'WPA3') {
    securityDict = `
			<key>WPA2</key>
			<dict>
				<key>Password</key>
				<string>${escapeXml(String(password))}</string>
			</dict>`;
  } else if (securityType === 'WEP') {
    securityDict = `
			<key>WEP</key>
			<dict>
				<key>Password</key>
				<string>${escapeXml(String(password))}</string>
			</dict>`;
  } else if (securityType === 'OPEN') {
    securityDict = '';
  }

  return `<dict>
			<key>SSID_STR</key>
			<string>${escapeXml(String(ssid))}</string>
			<key>HIDDEN_NETWORK</key>
			<${hidden ? 'true' : 'false'}/>
			<key>EncryptionType</key>
			<string>${escapeXml(String(securityType))}</string>${securityDict}
		</dict>`;
}

function buildPasscodePolicyPayload(s: Record<string, unknown>): string {
  const keys: string[] = [];
  const values: string[] = [];

  const mappings: Record<string, { key: string; type: string }> = {
    minLength: { key: 'minComplexChars', type: 'int' }, // Simplified mapping
    minLengthRaw: { key: 'minLength', type: 'int' },
    maxFailedAttempts: { key: 'maxFailedAttempts', type: 'int' },
    maxGracePeriodMinutes: { key: 'maxGracePeriodInMinutes', type: 'int' },
    maxInactivityMinutes: { key: 'maxInactivityInMinutes', type: 'int' },
    passcodeAgeDays: { key: 'daysUntilPasswordChange', type: 'int' },
    minComplexChars: { key: 'minComplexChars', type: 'int' },
    requireAlphanumeric: { key: 'requireAlphanumeric', type: 'bool' },
    allowSimple: { key: 'allowSimple', type: 'bool' },
  };

  for (const [inputKey, mapping] of Object.entries(mappings)) {
    if (s[inputKey] !== undefined) {
      keys.push(mapping.key);
      if (mapping.type === 'int') {
        values.push(`<integer>${Number(s[inputKey])}</integer>`);
      } else if (mapping.type === 'bool') {
        values.push(`<${s[inputKey] ? 'true' : 'false'}/>`);
      }
    }
  }

  // Also pass through any unknown keys as-is
  for (const [key, value] of Object.entries(s)) {
    if (!mappings[key]) {
      keys.push(key);
      values.push(buildXmlValue(value));
    }
  }

  return `<dict>
			${keys.map((k, i) => `<key>${escapeXml(k)}</key>\n\t\t\t${values[i]}`).join('\n\t\t\t')}
		</dict>`;
}

function buildAppRestrictionsPayload(s: Record<string, unknown>): string {
  const keys: string[] = [];
  const values: string[] = [];

  if (s.allowAppInstallation !== undefined) {
    keys.push('allowAppInstallation');
    values.push(`<${s.allowAppInstallation ? 'true' : 'false'}/>`);
  }
  if (s.allowCamera !== undefined) {
    keys.push('allowCamera');
    values.push(`<${s.allowCamera ? 'true' : 'false'}/>`);
  }
  if (s.allowScreenCapture !== undefined) {
    keys.push('allowScreenCapture');
    values.push(`<${s.allowScreenCapture ? 'true' : 'false'}/>`);
  }
  if (s.allowSiri !== undefined) {
    keys.push('allowSiri');
    values.push(`<${s.allowSiri ? 'true' : 'false'}/>`);
  }
  if (s.allowAppRemoval !== undefined) {
    keys.push('allowAppRemoval');
    values.push(`<${s.allowAppRemoval ? 'true' : 'false'}/>`);
  }
  if (Array.isArray(s.blockedAppBundleIds)) {
    keys.push('blacklistedAppBundleIDs');
    values.push(`<array>${s.blockedAppBundleIds.map((id) => `<string>${escapeXml(String(id))}</string>`).join('')}</array>`);
  }
  if (Array.isArray(s.allowedAppBundleIds)) {
    keys.push('whitelistedAppBundleIDs');
    values.push(`<array>${s.allowedAppBundleIds.map((id) => `<string>${escapeXml(String(id))}</string>`).join('')}</array>`);
  }

  return `<dict>
			${keys.map((k, i) => `<key>${escapeXml(k)}</key>\n\t\t\t${values[i]}`).join('\n\t\t\t')}
		</dict>`;
}

function buildCertificatePayload(s: Record<string, unknown>): string {
  const certName = s.certificateName || s.name || 'Certificate';
  const certData = s.certificateData || s.data || '';

  return `<dict>
			<key>PayloadCertificateFileName</key>
			<string>${escapeXml(String(certName))}.cer</string>
			<key>PayloadContent</key>
			<data>${String(certData)}</data>
		</dict>`;
}

function buildVpnPayload(s: Record<string, unknown>): string {
  const vpnType = s.vpnType || s.VPNType || 'IPSec';
  const server = s.serverAddress || s.server || '';
  const remoteId = s.remoteAddress || s.remoteIdentifier || server;

  let vpnDict = `
			<key>VPNType</key>
			<string>${escapeXml(String(vpnType))}</string>
			<key>VPNSubType</key>
			<string>com.apple.vpn.managed</string>
			<key>UserDefinedName</key>
			<string>${escapeXml(String(s.displayName || s.name || 'VPN'))}</string>
			<key>RemoteAddress</key>
			<string>${escapeXml(String(server))}</string>`;

  if (vpnType === 'IPSec') {
    vpnDict += `
			<key>AuthName</key>
			<string>${escapeXml(String(s.authName || ''))}</string>
			<key>AuthPassword</key>
			<string>${escapeXml(String(s.authPassword || ''))}</string>
			<key>RemoteIdentifier</key>
			<string>${escapeXml(String(remoteId))}</string>
			<key>LocalIdentifier</key>
			<string>${escapeXml(String(s.localId || ''))}</string>
			<key>SharedSecret</key>
			<data>${Buffer.from(String(s.sharedSecret || ''), 'utf8').toString('base64')}</data>`;
  }

  return `<dict>
			<key>UserDefinedName</key>
			<string>${escapeXml(String(s.displayName || s.name || 'VPN'))}</string>
			<key>VPN</key>
			<dict>
			${vpnDict}
			</dict>
			<key>VendorConfig</key>
			<dict/>
		</dict>`;
}

function buildWebClipPayload(s: Record<string, unknown>): string {
  const url = s.url || s.URL || '';
  const label = s.label || s.displayName || url;
  const fullScreen = s.fullScreen === true;
  const removable = s.removable !== false;

  return `<dict>
			<key>URL</key>
			<string>${escapeXml(String(url))}</string>
			<key>Label</key>
			<string>${escapeXml(String(label))}</string>
			<key>FullScreen</key>
			<${fullScreen ? 'true' : 'false'}/>
			<key>Removable</key>
			<${removable ? 'true' : 'false'}/>
			<key>Precomposed</key>
			<false/>
			<key>IgnoreManifestScope</key>
			<true/>
		</dict>`;
}

function buildSoftwareUpdatePayload(s: Record<string, unknown>): string {
  const enforceOsVersion = s.enforceOsVersion || '';
  const delayDays = s.delayInDays ?? 14;
  const localTime = s.installLocalDateTime || '';

  const inner: string[] = [
    `<key>EnforceSoftwareUpdate</key>\n\t\t\t<true/>`
  ];

  if (enforceOsVersion) {
    inner.push(
      `<key>EnforcedOSVersion</key>\n\t\t\t<string>${escapeXml(String(enforceOsVersion))}</string>`
    );
  }
  if (localTime) {
    inner.push(
      `<key>InstallAction</key>\n\t\t\t<string>InstallForceRestart</string>`,
      `<key>InstallLocalDateTime</key>\n\t\t\t<string>${escapeXml(String(localTime))}</string>`
    );
  }
  if (delayDays !== undefined) {
    inner.push(
      `<key>DelayInDays</key>\n\t\t\t<integer>${Number(delayDays)}</integer>`,
      `<key>MaxUserDeferrals</key>\n\t\t\t<integer>${Number(s.maxUserDeferrals ?? delayDays)}</integer>`
    );
  }

  return `<dict>\n\t\t\t${inner.join('\n\t\t\t')}\n\t\t</dict>`;
}

function buildSystemPreferencesPayload(s: Record<string, unknown>): string {
  const keys: string[] = [];
  const values: string[] = [];

  // Common macOS system preferences
  if (s.allowMissionControl !== undefined) {
    keys.push('EnableMissionControl');
    values.push(`<${s.allowMissionControl ? 'true' : 'false'}/>`);
  }
  if (s.allowSpotlight !== undefined) {
    keys.push('EnableSpotlight');
    values.push(`<${s.allowSpotlight ? 'true' : 'false'}/>`);
  }
  if (s.allowSiri !== undefined) {
    keys.push('DisableSiri');
    values.push(`<${!s.allowSiri ? 'true' : 'false'}/>`);
  }

  return `<dict>
			${keys.map((k, i) => `<key>${escapeXml(k)}</key>\n\t\t\t${values[i]}`).join('\n\t\t\t')}
		</dict>`;
}

/**
 * Generic fallback: emit all settings as key-value pairs.
 * Handles string, number, boolean, array, and object values.
 */
function buildGenericPayloadContent(settings: Record<string, unknown>): string {
  const entries = Object.entries(settings)
    .map(([key, value]) => `<key>${escapeXml(key)}</key>\n\t\t\t${buildXmlValue(value)}`)
    .join('\n\t\t\t');

  return `<dict>\n\t\t\t${entries}\n\t\t</dict>`;
}

/**
 * Build an XML value element for a given JavaScript value.
 */
function buildXmlValue(value: unknown): string {
  if (typeof value === 'string') {
    return `<string>${escapeXml(value)}</string>`;
  }
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? `<integer>${value}</integer>`
      : `<real>${value}</real>`;
  }
  if (typeof value === 'boolean') {
    return `<${value ? 'true' : 'false'}/>`;
  }
  if (value === null || value === undefined) {
    return `<string></string>`;
  }
  if (Array.isArray(value)) {
    return `<array>${value.map((v) => buildXmlValue(v)).join('')}</array>`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `<key>${escapeXml(k)}</key>\n\t\t\t\t${buildXmlValue(v)}`)
      .join('\n\t\t\t\t');
    return `<dict>\n\t\t\t\t${entries}\n\t\t\t</dict>`;
  }
  return `<string>${escapeXml(JSON.stringify(value))}</string>`;
}

/**
 * Build a single setting's XML (legacy helper, kept for compatibility).
 */
function buildSettingXml(key: string, value: unknown): string {
  return `<key>${escapeXml(key)}</key>\n\t\t\t\t${buildXmlValue(value)}`;
}

function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
