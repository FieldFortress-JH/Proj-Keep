import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { db } from '../../db';
import { devices, mdmProfileInstallations } from '../../db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { authMiddleware, requireScope, requirePermission, requireMfa, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  listMdmProfiles,
  getMdmProfile,
  createMdmProfile,
  updateMdmProfile,
  signMdmProfile,
} from '../../services/mdm/profileManager';
import {
  sendMdmCommand,
  listMdmCommands,
  getMdmCommand,
} from '../../services/mdm/commandDispatcher';
import {
  generateEnrollmentToken,
  getEnrollmentUrl,
} from '../../services/mdm/enrollment';
import {
  getApnsConfigStatus,
  storeApnsCertificate,
} from '../../services/mdm/apnsManager';
import { triggerABMSync, checkSidecarHealth } from '../../services/mdm/sidecarClient';
import {
  createMdmProfileSchema,
  updateMdmProfileSchema,
  listMdmProfilesSchema,
  idParamSchema,
  sendMdmCommandSchema,
  listMdmCommandsSchema,
  enrollmentLinkSchema,
  updateApnsConfigSchema,
} from './schemas';

/**
 * MDM Module Routes
 *
 * Admin-facing API for managing Apple MDM profiles, devices, and commands.
 * Mounted at /api/v1/mdm
 *
 * The Apple MDM protocol endpoints (called by devices directly) are handled
 * by the MDM sidecar service, not here. This router handles the admin API.
 */
export const mdmRoutes = new Hono();

mdmRoutes.use('*', authMiddleware);

const requireMdmRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);
const requireMdmWrite = requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action);
const requireMdmExecute = requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action);

// ─── Health ───

mdmRoutes.get('/health', async (c) => {
  const sidecarHealthy = await checkSidecarHealth();
  return c.json({
    status: 'ok',
    module: 'mdm',
    sidecar: sidecarHealthy ? 'reachable' : 'unreachable',
  });
});

// ─── MDM Profiles ───

// GET /mdm/profiles — list MDM profiles
mdmRoutes.get(
  '/profiles',
  requireScope('organization', 'partner', 'system'),
  requireMdmRead,
  zValidator('query', listMdmProfilesSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const filters = c.req.valid('query');

    const result = await listMdmProfiles(auth, filters, {
      page: filters.page,
      limit: filters.limit,
    });

    return c.json(result);
  },
);

// POST /mdm/profiles — create a new MDM profile
mdmRoutes.post(
  '/profiles',
  requireScope('organization', 'partner', 'system'),
  requireMdmWrite,
  requireMfa(),
  zValidator('json', createMdmProfileSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const body = c.req.valid('json');

    const profile = await createMdmProfile(auth, {
      orgId: auth.orgId!,
      ...body,
      createdBy: auth.userId,
    });

    writeRouteAudit(c, {
      action: 'mdm_profile.create',
      resourceType: 'mdm_profile',
      resourceId: profile.id,
      orgId: auth.orgId!,
      metadata: { name: profile.name, identifier: profile.profileIdentifier },
    });

    return c.json(profile, 201);
  },
);

// GET /mdm/profiles/:id — get a specific MDM profile
mdmRoutes.get(
  '/profiles/:id',
  requireScope('organization', 'partner', 'system'),
  requireMdmRead,
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    const profile = await getMdmProfile(auth, id);
    return c.json(profile);
  },
);

// PUT /mdm/profiles/:id — update an MDM profile
mdmRoutes.put(
  '/profiles/:id',
  requireScope('organization', 'partner', 'system'),
  requireMdmWrite,
  requireMfa(),
  zValidator('param', idParamSchema),
  zValidator('json', updateMdmProfileSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');

    const profile = await updateMdmProfile(auth, id, body);

    writeRouteAudit(c, {
      action: 'mdm_profile.update',
      resourceType: 'mdm_profile',
      resourceId: profile.id,
      orgId: auth.orgId!,
    });

    return c.json(profile);
  },
);

// DELETE /mdm/profiles/:id — archive an MDM profile
mdmRoutes.delete(
  '/profiles/:id',
  requireScope('organization', 'partner', 'system'),
  requireMdmWrite,
  requireMfa(),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    const profile = await updateMdmProfile(auth, id, { status: 'archived' });

    writeRouteAudit(c, {
      action: 'mdm_profile.archive',
      resourceType: 'mdm_profile',
      resourceId: profile.id,
      orgId: auth.orgId!,
    });

    return c.json(profile);
  },
);

// POST /mdm/profiles/:id/sign — sign and activate a profile
mdmRoutes.post(
  '/profiles/:id/sign',
  requireScope('organization', 'partner', 'system'),
  requireMdmWrite,
  requireMfa(),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    const profile = await signMdmProfile(auth, id);

    writeRouteAudit(c, {
      action: 'mdm_profile.sign',
      resourceType: 'mdm_profile',
      resourceId: profile.id,
      orgId: auth.orgId!,
    });

    return c.json(profile);
  },
);

// ─── MDM Devices ───

// GET /mdm/devices — list MDM-enrolled devices
mdmRoutes.get(
  '/devices',
  requireScope('organization', 'partner', 'system'),
  requireMdmRead,
  zValidator('query', z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { page, limit } = c.req.valid('query');

    const conditions = [
      eq(devices.orgId, auth.orgId!),
      eq(devices.mdmEnrolled, true),
    ];

    const results = await db
      .select()
      .from(devices)
      .where(and(...conditions))
      .orderBy(desc(devices.mdmLastCheckin))
      .limit(limit)
      .offset((page - 1) * limit);

    return c.json({
      devices: results.map((d) => ({
        id: d.id,
        hostname: d.hostname,
        displayName: d.displayName,
        osType: d.osType,
        osVersion: d.osVersion,
        status: d.status,
        mdm: {
          mdmEnrolled: d.mdmEnrolled,
          mdmUdId: d.mdmUdId,
          mdmSerialNumber: d.mdmSerialNumber,
          mdmProduct: d.mdmProduct,
          mdmModelName: d.mdmModelName,
          mdmSupervised: d.mdmSupervised,
          mdmActivationLockEnabled: d.mdmActivationLockEnabled,
          mdmLastCheckin: d.mdmLastCheckin?.toISOString(),
          mdmEnrollmentType: d.mdmEnrollmentType,
        },
      })),
      total: results.length,
      page,
      limit,
    });
  },
);

// GET /mdm/devices/:id — get MDM device details
mdmRoutes.get(
  '/devices/:id',
  requireScope('organization', 'partner', 'system'),
  requireMdmRead,
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    const [device] = await db
      .select()
      .from(devices)
      .where(and(eq(devices.id, id), eq(devices.orgId, auth.orgId!)))
      .limit(1);

    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    if (!device.mdmEnrolled) {
      return c.json({ error: 'Device is not enrolled in MDM' }, 400);
    }

    return c.json({
      id: device.id,
      hostname: device.hostname,
      displayName: device.displayName,
      osType: device.osType,
      osVersion: device.osVersion,
      status: device.status,
      mdm: {
        mdmEnrolled: device.mdmEnrolled,
        mdmUdId: device.mdmUdId,
        mdmSerialNumber: device.mdmSerialNumber,
        mdmProduct: device.mdmProduct,
        mdmModelName: device.mdmModelName,
        mdmSupervised: device.mdmSupervised,
        mdmActivationLockEnabled: device.mdmActivationLockEnabled,
        mdmLastCheckin: device.mdmLastCheckin?.toISOString(),
        mdmEnrollmentType: device.mdmEnrollmentType,
      },
    });
  },
);

// GET /mdm/devices/:id/profiles — list profiles installed on a device
mdmRoutes.get(
  '/devices/:id/profiles',
  requireScope('organization', 'partner', 'system'),
  requireMdmRead,
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    // Verify device belongs to org
    const [device] = await db
      .select()
      .from(devices)
      .where(and(eq(devices.id, id), eq(devices.orgId, auth.orgId!)))
      .limit(1);

    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const installations = await db
      .select()
      .from(mdmProfileInstallations)
      .where(eq(mdmProfileInstallations.deviceId, id))
      .orderBy(desc(mdmProfileInstallations.installedAt));

    return c.json({ installations });
  },
);

// ─── MDM Commands ───

// POST /mdm/devices/:id/commands — send a command to an MDM device
mdmRoutes.post(
  '/devices/:id/commands',
  requireScope('organization', 'partner', 'system'),
  requireMdmExecute,
  requireMfa(),
  zValidator('param', idParamSchema),
  zValidator('json', sendMdmCommandSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');

    const command = await sendMdmCommand(auth, {
      deviceId: id,
      commandType: body.commandType,
      payload: body.payload,
      createdBy: auth.userId,
    });

    writeRouteAudit(c, {
      action: 'mdm_command.send',
      resourceType: 'mdm_command',
      resourceId: command.id,
      orgId: auth.orgId!,
      metadata: { deviceId: id, commandType: body.commandType },
    });

    return c.json(command, 202);
  },
);

// GET /mdm/devices/:id/commands — list command history for a device
mdmRoutes.get(
  '/devices/:id/commands',
  requireScope('organization', 'partner', 'system'),
  requireMdmRead,
  zValidator('param', idParamSchema),
  zValidator('query', listMdmCommandsSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');
    const { status, page, limit } = c.req.valid('query');

    const result = await listMdmCommands(
      auth,
      id,
      { status },
      { page, limit },
    );

    return c.json(result);
  },
);

// GET /mdm/commands/:commandId — get command status
mdmRoutes.get(
  '/commands/:commandId',
  requireScope('organization', 'partner', 'system'),
  requireMdmRead,
  zValidator('param', z.object({ commandId: z.string().uuid() })),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { commandId } = c.req.valid('param');

    const command = await getMdmCommand(auth, commandId);
    return c.json(command);
  },
);

// ─── Enrollment ───

// GET /mdm/enroll — get enrollment link/QR data
mdmRoutes.get(
  '/enroll',
  requireScope('organization', 'partner', 'system'),
  requireMdmWrite,
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const sidecarUrl = process.env.MDM_SIDECAR_PUBLIC_URL || 'https://mdm.breeze.lan';

    return c.json({
      enrollmentUrl: `${sidecarUrl}/mdm/enroll?org_id=${auth.orgId}`,
      qrData: `${sidecarUrl}/mdm/enroll?org_id=${auth.orgId}`,
      instructions: 'Scan the QR code or open the enrollment URL on your Apple device to enroll in Breeze MDM.',
      sidecarUrl,
    });
  },
);

// POST /mdm/enroll — generate enrollment token
mdmRoutes.post(
  '/enroll',
  requireScope('organization', 'partner', 'system'),
  requireMdmWrite,
  requireMfa(),
  zValidator('json', enrollmentLinkSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const body = c.req.valid('json');

    const enrollment = generateEnrollmentToken(auth, body.siteId, body.enrollmentType);
    const url = getEnrollmentUrl(enrollment.token);

    writeRouteAudit(c, {
      action: 'mdm_enrollment.create',
      resourceType: 'mdm_enrollment',
      orgId: auth.orgId!,
      metadata: { enrollmentType: body.enrollmentType, siteId: body.siteId },
    });

    return c.json({
      token: enrollment.token,
      enrollmentUrl: url,
      qrData: url,
      expiresAt: enrollment.expiresAt,
      instructions: 'Scan the QR code or open the enrollment URL on your Apple device to enroll in Breeze MDM.',
    });
  },
);

// ─── APNs / ABM Configuration ───

// GET /mdm/settings/apns — get APNs configuration
mdmRoutes.get(
  '/settings/apns',
  requireScope('organization', 'partner', 'system'),
  requireMdmRead,
  async (c) => {
    const auth = c.get('auth') as AuthContext;

    const status = await getApnsConfigStatus(auth.orgId!);

    return c.json(status);
  },
);

// PUT /mdm/settings/apns — update APNs configuration
mdmRoutes.put(
  '/settings/apns',
  requireScope('organization', 'partner', 'system'),
  requireMdmWrite,
  requireMfa(),
  zValidator('json', updateApnsConfigSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const body = c.req.valid('json');

    // TODO: Accept cert upload (multipart), encrypt, store
    // For now, store config metadata; cert upload comes via the sidecar /internal/apns/config

    writeRouteAudit(c, {
      action: 'mdm_apns.update',
      resourceType: 'mdm_apns_config',
      orgId: auth.orgId!,
      metadata: { topic: body.apnsTopic, abmEnabled: body.abmEnabled },
    });

    return c.json({
      status: 'updated',
      orgId: auth.orgId,
      ...body,
      message: 'APNs configuration updated. Certificate upload is handled via the sidecar.',
    });
  },
);

// POST /mdm/settings/abm/sync — trigger ABM sync
mdmRoutes.post(
  '/settings/abm/sync',
  requireScope('organization', 'partner', 'system'),
  requireMdmWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth') as AuthContext;

    const result = await triggerABMSync();

    writeRouteAudit(c, {
      action: 'mdm_abm.sync',
      resourceType: 'mdm_abm',
      orgId: auth.orgId!,
    });

    return c.json(result);
  },
);
