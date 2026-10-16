/**
 * AI MDM Tools
 *
 * Tools for querying and managing Apple MDM devices, profiles, and commands
 * through Breeze's AI operator.
 *
 * - query_mdm_devices (Tier 1): List MDM-enrolled devices with status
 * - get_mdm_device_details (Tier 1): Full MDM device info (profiles, commands, check-in)
 * - list_mdm_profiles (Tier 1): List MDM configuration profiles
 * - get_mdm_profile (Tier 1): Get a profile's details and payload
 * - query_mdm_commands (Tier 1): List MDM command history for a device
 * - send_mdm_command (Tier 2): Send a command to an MDM device (lock, restart, etc.)
 * - list_mdm_profile_assignments (Tier 1): See which profiles are assigned via policies
 */

import { z } from 'zod';
import { db } from '../db';
import { devices, mdmProfiles, mdmCommands, mdmProfileInstallations, configPolicyFeatureLinks, configPolicyMdmProfileSettings, configurationPolicies } from '../db/schema';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { sendMdmCommand } from './mdm/commandDispatcher';
import { listMdmProfiles, getMdmProfile } from './mdm/profileManager';
import { sanitizeThrownToolError } from './aiToolErrors';

type AiToolTier = 1 | 2 | 3 | 4;

interface AiToolDef {
  name: string;
  description: string;
  tier: AiToolTier;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  handler: (input: Record<string, unknown>, auth: AuthContext) => Promise<unknown>;
}

function defineTool(def: AiToolDef): AiTool {
  return {
    name: def.name,
    description: def.description,
    tier: def.tier,
    inputSchema: def.inputSchema,
    handler: def.handler,
  } as unknown as AiTool;
}

// ─── Tool Definitions ───

const queryMdmDevicesTool = defineTool({
  name: 'query_mdm_devices',
  description: 'List MDM-enrolled Apple devices (iPhone, iPad, Mac) in the organization. Shows enrollment status, last check-in, supervised state, and OS version. Use this to find which Apple devices are managed via MDM.',
  tier: 1,
  inputSchema: z.object({
    status: z.enum(['online', 'offline', 'all']).optional().default('all').describe('Filter by device status'),
    supervised: z.boolean().optional().describe('Filter by supervised (ABM-enrolled) state'),
    osType: z.enum(['ios', 'ipados', 'macos', 'all']).optional().default('all').describe('Filter by OS type'),
    search: z.string().optional().describe('Search by hostname, model name, or serial number'),
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  }),
  handler: async (input, auth) => {
    const { status, supervised, osType, search, page, limit } = input as {
      status: string; supervised?: boolean; osType: string; search?: string; page: number; limit: number;
    };

    const conditions = [
      eq(devices.orgId, auth.orgId!),
      eq(devices.mdmEnrolled, true),
    ];

    if (status !== 'all') {
      conditions.push(eq(devices.status, status));
    }
    if (supervised !== undefined) {
      conditions.push(eq(devices.mdmSupervised, supervised));
    }
    if (osType !== 'all') {
      conditions.push(eq(devices.osType, osType));
    }
    if (search) {
      conditions.push(
        sql`(${devices.hostname} ILIKE ${`%${search}%`} OR ${devices.mdmModelName} ILIKE ${`%${search}%`} OR ${devices.mdmSerialNumber} ILIKE ${`%${search}%`})`
      );
    }

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(devices)
      .where(and(...conditions));

    const results = await db
      .select()
      .from(devices)
      .where(and(...conditions))
      .orderBy(desc(devices.mdmLastCheckin))
      .limit(limit)
      .offset((page - 1) * limit);

    return {
      devices: results.map((d) => ({
        id: d.id,
        hostname: d.hostname,
        displayName: d.displayName,
        osType: d.osType,
        osVersion: d.osVersion,
        status: d.status,
        modelName: d.mdmModelName,
        serialNumber: d.mdmSerialNumber,
        supervised: d.mdmSupervised,
        activationLock: d.mdmActivationLockEnabled,
        enrollmentType: d.mdmEnrollmentType,
        lastCheckin: d.mdmLastCheckin?.toISOString(),
        udid: d.mdmUdId,
      })),
      total: count,
      page,
      limit,
    };
  },
});

const getMdmDeviceDetailsTool = defineTool({
  name: 'get_mdm_device_details',
  description: 'Get comprehensive MDM details for a specific Apple device, including installed profiles, recent commands, and enrollment info. Requires the device ID (from query_mdm_devices or query_devices).',
  tier: 1,
  inputSchema: z.object({
    deviceId: z.string().uuid().describe('The device ID (UUID)'),
  }),
  handler: async (input, auth) => {
    const { deviceId } = input as { deviceId: string };

    const [device] = await db
      .select()
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.orgId, auth.orgId!)))
      .limit(1);

    if (!device) {
      throw new Error('Device not found');
    }

    if (!device.mdmEnrolled) {
      return {
        deviceId: device.id,
        hostname: device.hostname,
        mdmEnrolled: false,
        message: 'This device is not enrolled in MDM. It may be agent-managed only.',
      };
    }

    // Get installed profiles
    const installations = await db
      .select({
        installation: mdmProfileInstallations,
        profile: mdmProfiles,
      })
      .from(mdmProfileInstallations)
      .innerJoin(mdmProfiles, eq(mdmProfileInstallations.profileId, mdmProfiles.id))
      .where(eq(mdmProfileInstallations.deviceId, deviceId))
      .orderBy(desc(mdmProfileInstallations.installedAt));

    // Get recent commands (last 20)
    const recentCommands = await db
      .select()
      .from(mdmCommands)
      .where(eq(mdmCommands.deviceId, deviceId))
      .orderBy(desc(mdmCommands.createdAt))
      .limit(20);

    return {
      deviceId: device.id,
      hostname: device.hostname,
      displayName: device.displayName,
      osType: device.osType,
      osVersion: device.osVersion,
      status: device.status,
      mdm: {
        enrolled: true,
        udid: device.mdmUdId,
        serialNumber: device.mdmSerialNumber,
        product: device.mdmProduct,
        modelName: device.mdmModelName,
        supervised: device.mdmSupervised,
        activationLock: device.mdmActivationLockEnabled,
        enrollmentType: device.mdmEnrollmentType,
        lastCheckin: device.mdmLastCheckin?.toISOString(),
      },
      installedProfiles: installations.map((i) => ({
        profileId: i.profile.id,
        name: i.profile.name,
        identifier: i.profile.profileIdentifier,
        status: i.installation.status,
        installedAt: i.installation.installedAt?.toISOString(),
        verifiedAt: i.installation.verifiedAt?.toISOString(),
      })),
      recentCommands: recentCommands.map((c) => ({
        id: c.id,
        type: c.commandType,
        status: c.status,
        createdAt: c.createdAt.toISOString(),
        sentAt: c.sentAt?.toISOString(),
        acknowledgedAt: c.acknowledgedAt?.toISOString(),
        errorCode: c.errorCode,
      })),
    };
  },
});

const listMdmProfilesTool = defineTool({
  name: 'list_mdm_profiles',
  description: 'List Apple MDM configuration profiles in the organization. Profiles define settings like WiFi, passcode policy, app restrictions, VPN, etc. that are pushed to Apple devices.',
  tier: 1,
  inputSchema: z.object({
    status: z.enum(['draft', 'active', 'archived', 'all']).optional().default('active').describe('Filter by profile status'),
    search: z.string().optional().describe('Search by profile name or identifier'),
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  }),
  handler: async (input, auth) => {
    const { status, search, page, limit } = input as {
      status: string; search?: string; page: number; limit: number;
    };

    const result = await listMdmProfiles(auth, {
      status: status === 'all' ? undefined : status,
      search,
    }, { page, limit });

    return {
      profiles: result.profiles.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        status: p.status,
        identifier: p.profileIdentifier,
        displayName: p.profileDisplayName,
        targetPlatforms: p.targetPlatforms,
        payloadCount: Array.isArray(p.payloads) ? p.payloads.length : 0,
        removalDisallowed: p.profileRemovalDisallowed,
        createdAt: p.createdAt.toISOString(),
      })),
      total: result.total,
      page: result.page,
      limit: result.limit,
    };
  },
});

const getMdmProfileTool = defineTool({
  name: 'get_mdm_profile',
  description: 'Get full details of an MDM configuration profile, including its structured payloads (WiFi settings, passcode policy, etc.). Requires the profile ID from list_mdm_profiles.',
  tier: 1,
  inputSchema: z.object({
    profileId: z.string().uuid().describe('The MDM profile ID (UUID)'),
  }),
  handler: async (input, auth) => {
    const { profileId } = input as { profileId: string };

    const profile = await getMdmProfile(auth, profileId);

    return {
      id: profile.id,
      name: profile.name,
      description: profile.description,
      status: profile.status,
      identifier: profile.profileIdentifier,
      displayName: profile.profileDisplayName,
      description_field: profile.profileDescription,
      organization: profile.profileOrganization,
      removalDisallowed: profile.profileRemovalDisallowed,
      targetPlatforms: profile.targetPlatforms,
      payloads: profile.payloads,
      hasSignedPayload: !!profile.profilePayload,
      createdAt: profile.createdAt.toISOString(),
      updatedAt: profile.updatedAt.toISOString(),
    };
  },
});

const queryMdmCommandsTool = defineTool({
  name: 'query_mdm_commands',
  description: 'List MDM command history for a specific Apple device. Shows commands sent (lock, wipe, restart, install profile, etc.) and their delivery status. Requires the device ID.',
  tier: 1,
  inputSchema: z.object({
    deviceId: z.string().uuid().describe('The device ID (UUID)'),
    status: z.enum(['pending', 'queued', 'sent', 'acknowledged', 'error', 'failed', 'timeout', 'cancelled', 'all']).optional().default('all').describe('Filter by command status'),
    limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  }),
  handler: async (input, auth) => {
    const { deviceId, status, limit } = input as {
      deviceId: string; status: string; limit: number;
    };

    // Verify device belongs to org
    const [device] = await db
      .select()
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.orgId, auth.orgId!)))
      .limit(1);

    if (!device) {
      throw new Error('Device not found');
    }

    const conditions = [eq(mdmCommands.deviceId, deviceId)];
    if (status !== 'all') {
      conditions.push(eq(mdmCommands.status, status as typeof mdmCommands.status._.data[number]));
    }

    const commands = await db
      .select()
      .from(mdmCommands)
      .where(and(...conditions))
      .orderBy(desc(mdmCommands.createdAt))
      .limit(limit);

    return {
      deviceId,
      deviceHostname: device.hostname,
      commands: commands.map((c) => ({
        id: c.id,
        commandUuid: c.commandUuid,
        type: c.commandType,
        status: c.status,
        payload: c.payload,
        result: c.resultPayload,
        errorCode: c.errorCode,
        createdAt: c.createdAt.toISOString(),
        sentAt: c.sentAt?.toISOString(),
        acknowledgedAt: c.acknowledgedAt?.toISOString(),
        expiresAt: c.expiresAt?.toISOString(),
      })),
      total: commands.length,
    };
  },
});

const sendMdmCommandTool = defineTool({
  name: 'send_mdm_command',
  description: 'Send an MDM command to an Apple device (lock, restart, shutdown, clear passcode, query info, install/remove profile). Tier 2 — requires human approval. For destructive commands (wipe), additional confirmation is needed.',
  tier: 2,
  inputSchema: z.object({
    deviceId: z.string().uuid().describe('The target device ID (UUID)'),
    commandType: z.enum([
      'device_lock',
      'restart_device',
      'shutdown_device',
      'clear_passcode',
      'device_information',
      'profile_list',
      'security_info',
      'certificate_list',
      'install_profile',
      'remove_profile',
    ]).describe('The MDM command to send'),
    payload: z.record(z.unknown()).optional().describe('Command-specific payload (e.g., { profileData: "base64..." } for install_profile, { message: "..." } for device_lock)'),
    reason: z.string().optional().describe('Reason for sending this command (logged in audit)'),
  }),
  handler: async (input, auth) => {
    const { deviceId, commandType, payload, reason } = input as {
      deviceId: string;
      commandType: 'device_lock' | 'restart_device' | 'shutdown_device' | 'clear_passcode' | 'device_information' | 'profile_list' | 'security_info' | 'certificate_list' | 'install_profile' | 'remove_profile';
      payload?: Record<string, unknown>;
      reason?: string;
    };

    try {
      const command = await sendMdmCommand(auth, {
        deviceId,
        commandType,
        payload: reason ? { ...payload, _reason: reason } : payload,
        createdBy: auth.userId,
      });

      return {
        success: true,
        commandId: command.id,
        commandUuid: command.commandUuid,
        status: command.status,
        deviceId,
        commandType,
        message: `Command '${commandType}' queued for delivery to device. The device will receive it on its next check-in (or immediately if an APNs push is sent).`,
      };
    } catch (err) {
      throw new Error(sanitizeThrownToolError(err));
    }
  },
});

const listMdmProfileAssignmentsTool = defineTool({
  name: 'list_mdm_profile_assignments',
  description: 'List which MDM profiles are assigned to which configuration policies. Shows the policy → profile mapping that drives automatic profile deployment to devices.',
  tier: 1,
  inputSchema: z.object({
    policyId: z.string().uuid().optional().describe('Filter by specific policy ID'),
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  }),
  handler: async (input, auth) => {
    const { policyId, page, limit } = input as {
      policyId?: string; page: number; limit: number;
    };

    const conditions = [eq(configurationPolicies.orgId, auth.orgId!)];
    if (policyId) {
      conditions.push(eq(configurationPolicies.id, policyId));
    }

    const assignments = await db
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
        )
      )
      .innerJoin(
        configPolicyMdmProfileSettings,
        eq(configPolicyMdmProfileSettings.featureLinkId, configPolicyFeatureLinks.id),
      )
      .where(and(...conditions))
      .limit(limit)
      .offset((page - 1) * limit);

    // Enrich with profile names
    const profileIds = [...new Set(assignments.flatMap((a) => a.settings.profileIds))];
    const profiles = profileIds.length > 0 ? await db
      .select()
      .from(mdmProfiles)
      .where(and(
        eq(mdmProfiles.orgId, auth.orgId!),
        inArray(mdmProfiles.id, profileIds),
      )) : [];

    const profileMap = new Map(profiles.map((p) => [p.id, p]));

    return {
      assignments: assignments.map((a) => ({
        policyId: a.policy.id,
        policyName: a.policy.name,
        policyStatus: a.policy.status,
        enforceExactSet: a.settings.enforceExactSet,
        profiles: a.settings.profileIds.map((id) => ({
          id,
          name: profileMap.get(id)?.name || '(deleted profile)',
          identifier: profileMap.get(id)?.profileIdentifier,
        })),
      })),
      total: assignments.length,
      page,
      limit,
    };
  },
});

// ─── Registration ───

export function registerMdmTools(aiTools: Map<string, AiTool>): void {
  aiTools.set(queryMdmDevicesTool.name, queryMdmDevicesTool);
  aiTools.set(getMdmDeviceDetailsTool.name, getMdmDeviceDetailsTool);
  aiTools.set(listMdmProfilesTool.name, listMdmProfilesTool);
  aiTools.set(getMdmProfileTool.name, getMdmProfileTool);
  aiTools.set(queryMdmCommandsTool.name, queryMdmCommandsTool);
  aiTools.set(sendMdmCommandTool.name, sendMdmCommandTool);
  aiTools.set(listMdmProfileAssignmentsTool.name, listMdmProfileAssignmentsTool);
}
