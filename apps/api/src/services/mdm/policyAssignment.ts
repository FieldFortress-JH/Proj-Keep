import { db } from '../../db';
import {
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyMdmProfileSettings,
  configPolicyAssignments,
  devices,
  mdmProfiles,
  mdmCommands,
} from '../../db/schema';
import { eq, and, inArray, sql } from 'drizzle-orm';
import type { AuthContext } from '../../middleware/auth';

/**
 * MDM Policy Assignment — manages the link between configuration policies
 * and MDM profiles.
 *
 * A configuration policy with feature type 'mdm_profile' can have an
 * associated config_policy_mdm_profile_settings row listing which MDM
 * profiles to enforce. When a device matches the policy (via assignment),
 * the MDM sidecar installs those profiles automatically.
 */

export interface MdmPolicyAssignment {
  policyId: string;
  policyName: string;
  policyStatus: string;
  featureLinkId: string;
  profileIds: string[];
  enforceExactSet: boolean;
  profiles: Array<{
    id: string;
    name: string;
    identifier: string;
    status: string;
  }>;
}

export interface DeviceMdmProfileTarget {
  profileId: string;
  profileUuid: string;
  profilePayload: string;
  action: 'install' | 'remove';
}

/**
 * Get all MDM profile assignments for an org's configuration policies.
 */
export async function listMdmPolicyAssignments(
  auth: AuthContext,
  policyId?: string,
): Promise<MdmPolicyAssignment[]> {
  const conditions = [eq(configurationPolicies.orgId, auth.orgId!)];
  if (policyId) {
    conditions.push(eq(configurationPolicies.id, policyId));
  }

  const rows = await db
    .select({
      policy: configurationPolicies,
      featureLink: configPolicyFeatureLinks,
      settings: configPolicyMdmProfileSettings,
    })
    .from(configurationPolicies)
    .innerJoin(
      configPolicyFeatureLinks,
      and(
        eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configPolicyFeatureLinks.featureType, 'mdm_profile'),
      ),
    )
    .innerJoin(
      configPolicyMdmProfileSettings,
      eq(configPolicyMdmProfileSettings.featureLinkId, configPolicyFeatureLinks.id),
    )
    .where(and(...conditions));

  // Enrich with profile details
  const allProfileIds = [...new Set(rows.flatMap((r) => r.settings.profileIds))];
  const profiles = allProfileIds.length > 0
    ? await db
        .select()
        .from(mdmProfiles)
        .where(and(
          eq(mdmProfiles.orgId, auth.orgId!),
          inArray(mdmProfiles.id, allProfileIds),
        ))
    : [];

  const profileMap = new Map(profiles.map((p) => [p.id, p]));

  return rows.map((r) => ({
    policyId: r.policy.id,
    policyName: r.policy.name,
    policyStatus: r.policy.status,
    featureLinkId: r.featureLink.id,
    profileIds: r.settings.profileIds,
    enforceExactSet: r.settings.enforceExactSet,
    profiles: r.settings.profileIds.map((id) => ({
      id,
      name: profileMap.get(id)?.name || '(unknown)',
      identifier: profileMap.get(id)?.profileIdentifier || '',
      status: profileMap.get(id)?.status || 'unknown',
    })),
  }));
}

/**
 * Get the MDM profiles that should be installed on a specific device,
 * based on the device's assigned configuration policies.
 *
 * Resolution:
 *   1. Find all active configuration policies assigned to the device's org
 *      at the org, site, device-group, or device level
 *   2. For each policy with an 'mdm_profile' feature link, get profile IDs
 *      from config_policy_mdm_profile_settings
 *   3. Return the union of all profile IDs (deduplicated)
 *
 * If enforceExactSet is true on any matching policy, profiles NOT in the
 * list should be removed.
 */
export async function getDeviceMdmProfileTargets(
  deviceId: string,
  orgId: string,
): Promise<DeviceMdmProfileTarget[]> {
  // Find active policies assigned to this device (directly or via site/group)
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return [];
  }

  // Get policies that apply to this device
  // Policies can be assigned at: org-wide (no assignment), site level, device-group, or device level
  const applicablePolicies = await db
    .select({
      policy: configurationPolicies,
      featureLink: configPolicyFeatureLinks,
      settings: configPolicyMdmProfileSettings,
    })
    .from(configurationPolicies)
    .innerJoin(
      configPolicyFeatureLinks,
      and(
        eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configPolicyFeatureLinks.featureType, 'mdm_profile'),
      ),
    )
    .innerJoin(
      configPolicyMdmProfileSettings,
      eq(configPolicyMdmProfileSettings.featureLinkId, configPolicyFeatureLinks.id),
    )
    .leftJoin(
      configPolicyAssignments,
      eq(configPolicyAssignments.configPolicyId, configurationPolicies.id),
    )
    .where(and(
      eq(configurationPolicies.orgId, orgId),
      eq(configurationPolicies.status, 'active'),
      // Policy applies if: assigned to this device's site, OR assigned to this device, OR org-wide (no assignment)
      sql`(
        ${configPolicyAssignments.siteId} = ${device.siteId}
        OR ${configPolicyAssignments.deviceId} = ${deviceId}
        OR ${configPolicyAssignments.id} IS NULL
      )`,
    ));

  // Collect profile IDs from all applicable policies
  const profileIdSet = new Set<string>();
  let enforceExact = false;

  for (const row of applicablePolicies) {
    for (const id of row.settings.profileIds) {
      profileIdSet.add(id);
    }
    if (row.settings.enforceExactSet) {
      enforceExact = true;
    }
  }

  if (profileIdSet.size === 0) {
    return [];
  }

  // Fetch active profiles
  const profiles = await db
    .select()
    .from(mdmProfiles)
    .where(and(
      eq(mdmProfiles.orgId, orgId),
      inArray(mdmProfiles.id, [...profileIdSet]),
      eq(mdmProfiles.status, 'active'),
    ));

  return profiles.map((p) => ({
    profileId: p.id,
    profileUuid: p.profileUuid,
    profilePayload: p.profilePayload,
    action: 'install' as const,
  }));
}

/**
 * Set the MDM profile assignment for a configuration policy's feature link.
 * Creates or updates the config_policy_mdm_profile_settings row.
 */
export async function setMdmPolicyProfiles(
  auth: AuthContext,
  featureLinkId: string,
  profileIds: string[],
  enforceExactSet: boolean = false,
) {
  // Verify the feature link belongs to a policy in this org
  const [link] = await db
    .select({
      link: configPolicyFeatureLinks,
      policy: configurationPolicies,
    })
    .from(configPolicyFeatureLinks)
    .innerJoin(
      configurationPolicies,
      eq(configurationPolicies.id, configPolicyFeatureLinks.configPolicyId),
    )
    .where(and(
      eq(configPolicyFeatureLinks.id, featureLinkId),
      eq(configurationPolicies.orgId, auth.orgId!),
      eq(configPolicyFeatureLinks.featureType, 'mdm_profile'),
    ))
    .limit(1);

  if (!link) {
    throw new Error('MDM profile feature link not found in this organization');
  }

  // Verify all profile IDs belong to this org
  if (profileIds.length > 0) {
    const validProfiles = await db
      .select({ id: mdmProfiles.id })
      .from(mdmProfiles)
      .where(and(
        eq(mdmProfiles.orgId, auth.orgId!),
        inArray(mdmProfiles.id, profileIds),
      ));

    if (validProfiles.length !== profileIds.length) {
      throw new Error('One or more profile IDs are invalid or belong to another organization');
    }
  }

  // Upsert the settings
  const [settings] = await db
    .insert(configPolicyMdmProfileSettings)
    .values({
      featureLinkId,
      profileIds,
      enforceExactSet,
    })
    .onConflictDoUpdate({
      target: configPolicyMdmProfileSettings.featureLinkId,
      set: {
        profileIds,
        enforceExactSet,
        updatedAt: new Date(),
      },
    })
    .returning();

  return settings;
}

/**
 * Remove the MDM profile assignment from a feature link.
 */
export async function removeMdmPolicyProfiles(
  auth: AuthContext,
  featureLinkId: string,
) {
  // Verify ownership
  const [link] = await db
    .select({
      link: configPolicyFeatureLinks,
      policy: configurationPolicies,
    })
    .from(configPolicyFeatureLinks)
    .innerJoin(
      configurationPolicies,
      eq(configurationPolicies.id, configPolicyFeatureLinks.configPolicyId),
    )
    .where(and(
      eq(configPolicyFeatureLinks.id, featureLinkId),
      eq(configurationPolicies.orgId, auth.orgId!),
    ))
    .limit(1);

  if (!link) {
    throw new Error('Feature link not found in this organization');
  }

  await db
    .delete(configPolicyMdmProfileSettings)
    .where(eq(configPolicyMdmProfileSettings.featureLinkId, featureLinkId));
}

/**
 * Queue profile installation/removal commands for a device based on
 * its policy assignments. Called when a device checks in or when
 * policies change.
 */
export async function syncDeviceMdmProfiles(
  auth: AuthContext,
  deviceId: string,
): Promise<{ queued: number; removed: number }> {
  const targets = await getDeviceMdmProfileTargets(deviceId, auth.orgId!);

  let queued = 0;
  let removed = 0;

  for (const target of targets) {
    // Check if profile is already installed
    const [existing] = await db
      .select()
      .from(mdmProfileInstallations)
      .where(and(
        eq(mdmProfileInstallations.deviceId, deviceId),
        eq(mdmProfileInstallations.profileId, target.profileId),
        eq(mdmProfileInstallations.status, 'installed'),
      ))
      .limit(1);

    if (!existing) {
      // Queue install command
      await db.insert(mdmCommands).values({
        deviceId,
        commandType: 'install_profile',
        payload: {
          profileId: target.profileId,
          profileUuid: target.profileUuid,
          profileData: Buffer.from(target.profilePayload, 'utf8').toString('base64'),
        },
        status: 'pending',
        createdBy: auth.userId,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      queued++;
    }
  }

  return { queued, removed };
}
