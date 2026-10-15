import { z } from 'zod';

// ─── MDM Profile Schemas ───

export const createMdmProfileSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  profileIdentifier: z.string().min(1).max(255),
  profileDisplayName: z.string().min(1).max(255),
  profileDescription: z.string().optional(),
  profileOrganization: z.string().max(255).optional(),
  profileRemovalDisallowed: z.boolean().default(false),
  payloads: z.array(z.object({
    type: z.string(),
    identifier: z.string(),
    uuid: z.string().optional(),
    displayName: z.string().optional(),
    removalDisallowed: z.boolean().optional(),
    settings: z.record(z.unknown()),
  })).default([]),
  targetPlatforms: z.array(z.enum(['ios', 'ipados', 'macos'])).default(['ios', 'ipados', 'macos']),
});

export const updateMdmProfileSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  status: z.enum(['draft', 'active', 'archived']).optional(),
  profileDisplayName: z.string().min(1).max(255).optional(),
  profileDescription: z.string().optional(),
  profileOrganization: z.string().max(255).optional(),
  profileRemovalDisallowed: z.boolean().optional(),
  payloads: z.array(z.object({
    type: z.string(),
    identifier: z.string(),
    uuid: z.string().optional(),
    displayName: z.string().optional(),
    removalDisallowed: z.boolean().optional(),
    settings: z.record(z.unknown()),
  })).optional(),
  targetPlatforms: z.array(z.enum(['ios', 'ipados', 'macos'])).optional(),
});

export const listMdmProfilesSchema = z.object({
  status: z.enum(['draft', 'active', 'archived']).optional(),
  search: z.string().optional(),
  platform: z.enum(['ios', 'ipados', 'macos']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const idParamSchema = z.object({
  id: z.string().uuid(),
});

// ─── MDM Command Schemas ───

export const sendMdmCommandSchema = z.object({
  commandType: z.enum([
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
    'certificate_list',
  ]),
  payload: z.record(z.unknown()).optional(),
});

export const listMdmCommandsSchema = z.object({
  status: z.enum(['pending', 'queued', 'sent', 'acknowledged', 'error', 'failed', 'timeout', 'cancelled']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

// ─── Enrollment Schemas ───

export const enrollmentLinkSchema = z.object({
  orgId: z.string().uuid(),
  siteId: z.string().uuid().optional(),
  enrollmentType: z.enum(['manual', 'abm_ade', 'user_enrollment']).default('manual'),
});

// ─── APNs Configuration Schemas ───

export const updateApnsConfigSchema = z.object({
  apnsTopic: z.string().max(255).optional(),
  abmEnabled: z.boolean().optional(),
  scepEnabled: z.boolean().optional(),
  scepCaFingerprint: z.string().max(255).optional(),
});

// ─── Policy Feature Settings Schema ───

export const mdmProfilePolicySettingsSchema = z.object({
  profileIds: z.array(z.string().uuid()).default([]),
  enforceExactSet: z.boolean().default(false),
});
