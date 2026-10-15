import { db } from '../../db';
import { mdmProfiles, mdmProfileInstallations, devices } from '../../db/schema';
import { eq, and, desc } from 'drizzle-orm';
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

/**
 * List MDM profiles for an organization.
 */
export async function listMdmProfiles(
  auth: AuthContext,
  filters: { status?: string; search?: string; platform?: string },
  pagination: { page: number; limit: number },
) {
  // TODO: Implement with proper org scoping and RLS
  const conditions = [eq(mdmProfiles.orgId, auth.orgId!)];

  if (filters.status) {
    conditions.push(eq(mdmProfiles.status, filters.status as 'draft' | 'active' | 'archived'));
  }

  const results = await db
    .select()
    .from(mdmProfiles)
    .where(and(...conditions))
    .orderBy(desc(mdmProfiles.createdAt))
    .limit(pagination.limit)
    .offset((pagination.page - 1) * pagination.limit);

  return { profiles: results, total: results.length, page: pagination.page, limit: pagination.limit };
}

/**
 * Get a single MDM profile by ID.
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
 */
export async function createMdmProfile(auth: AuthContext, input: CreateMdmProfileInput) {
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
      payloads: input.payloads,
      targetPlatforms: input.targetPlatforms,
      createdBy: input.createdBy,
    })
    .returning();

  return profile;
}

/**
 * Update an MDM profile.
 */
export async function updateMdmProfile(auth: AuthContext, profileId: string, input: UpdateMdmProfileInput) {
  const [updated] = await db
    .update(mdmProfiles)
    .set({
      ...input,
      updatedAt: new Date(),
    })
    .where(and(eq(mdmProfiles.id, profileId), eq(mdmProfiles.orgId, auth.orgId!)))
    .returning();

  if (!updated) {
    throw new Error('Profile not found');
  }

  return updated;
}

/**
 * Sign and activate a profile — generates the .mobileconfig XML.
 */
export async function signMdmProfile(auth: AuthContext, profileId: string) {
  const profile = await getMdmProfile(auth, profileId);

  // Generate the signed .mobileconfig XML from the structured payloads
  const mobileconfig = buildMobileconfig(profile);

  // TODO: Sign with org's signing certificate

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
 * Build a .mobileconfig XML string from a profile's structured payloads.
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
 * TODO: Implement full payload type mapping for all Apple payload types.
 */
function buildPayloadXml(payload: MdmProfilePayload): string {
  const settingsXml = Object.entries(payload.settings)
    .map(([key, value]) => buildSettingXml(key, value))
    .join('\n\t\t\t\t');

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
			<dict>
				${settingsXml}
			</dict>
		</dict>`;
}

function buildSettingXml(key: string, value: unknown): string {
  if (typeof value === 'string') {
    return `<key>${escapeXml(key)}</key>\n\t\t\t\t<string>${escapeXml(value)}</string>`;
  }
  if (typeof value === 'number') {
    return `<key>${escapeXml(key)}</key>\n\t\t\t\t<integer>${value}</integer>`;
  }
  if (typeof value === 'boolean') {
    return `<key>${escapeXml(key)}</key>\n\t\t\t\t<${value ? 'true' : 'false'}/>`;
  }
  return `<key>${escapeXml(key)}</key>\n\t\t\t\t<string>${escapeXml(JSON.stringify(value))}</string>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
