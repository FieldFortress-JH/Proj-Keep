import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requireScope, requirePermission, requireMfa, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
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

mdmRoutes.get('/health', (c) => {
  return c.json({ status: 'ok', module: 'mdm' });
});

// ─── MDM Profiles ───

// GET /mdm/profiles — list MDM profiles
mdmRoutes.get('/profiles', requireScope('organization', 'partner', 'system'), requireMdmRead, async (c) => {
  const auth = c.get('auth') as AuthContext;
  // TODO: Implement listMdmProfiles service call
  return c.json({ profiles: [], total: 0, page: 1, limit: 25 });
});

// POST /mdm/profiles — create a new MDM profile
mdmRoutes.post('/profiles', requireScope('organization', 'partner', 'system'), requireMdmWrite, requireMfa(), async (c) => {
  const auth = c.get('auth') as AuthContext;
  // TODO: Implement createMdmProfile service call
  return c.json({ error: 'Not yet implemented' }, 501);
});

// GET /mdm/profiles/:id — get a specific MDM profile
mdmRoutes.get('/profiles/:id', requireScope('organization', 'partner', 'system'), requireMdmRead, async (c) => {
  const auth = c.get('auth') as AuthContext;
  const { id } = c.req.param();
  // TODO: Implement getMdmProfile service call
  return c.json({ error: 'Not yet implemented' }, 501);
});

// PUT /mdm/profiles/:id — update an MDM profile
mdmRoutes.put('/profiles/:id', requireScope('organization', 'partner', 'system'), requireMdmWrite, requireMfa(), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const { id } = c.req.param();
  // TODO: Implement updateMdmProfile service call
  return c.json({ error: 'Not yet implemented' }, 501);
});

// DELETE /mdm/profiles/:id — archive an MDM profile
mdmRoutes.delete('/profiles/:id', requireScope('organization', 'partner', 'system'), requireMdmWrite, requireMfa(), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const { id } = c.req.param();
  // TODO: Implement archiveMdmProfile service call
  return c.json({ error: 'Not yet implemented' }, 501);
});

// POST /mdm/profiles/:id/sign — sign and activate a profile
mdmRoutes.post('/profiles/:id/sign', requireScope('organization', 'partner', 'system'), requireMdmWrite, requireMfa(), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const { id } = c.req.param();
  // TODO: Implement signMdmProfile service call
  return c.json({ error: 'Not yet implemented' }, 501);
});

// ─── MDM Devices ───

// GET /mdm/devices — list MDM-enrolled devices
mdmRoutes.get('/devices', requireScope('organization', 'partner', 'system'), requireMdmRead, async (c) => {
  const auth = c.get('auth') as AuthContext;
  // TODO: Implement listMdmDevices — queries devices WHERE mdm_enrolled = true
  return c.json({ devices: [], total: 0, page: 1, limit: 25 });
});

// GET /mdm/devices/:id — get MDM device details
mdmRoutes.get('/devices/:id', requireScope('organization', 'partner', 'system'), requireMdmRead, async (c) => {
  const auth = c.get('auth') as AuthContext;
  const { id } = c.req.param();
  // TODO: Implement getMdmDevice — device with MDM tab data
  return c.json({ error: 'Not yet implemented' }, 501);
});

// GET /mdm/devices/:id/profiles — list profiles installed on a device
mdmRoutes.get('/devices/:id/profiles', requireScope('organization', 'partner', 'system'), requireMdmRead, async (c) => {
  const auth = c.get('auth') as AuthContext;
  const { id } = c.req.param();
  // TODO: Implement listDeviceMdmProfiles
  return c.json({ installations: [] });
});

// ─── MDM Commands ───

// POST /mdm/devices/:id/commands — send a command to an MDM device
mdmRoutes.post('/devices/:id/commands', requireScope('organization', 'partner', 'system'), requireMdmExecute, requireMfa(), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const { id } = c.req.param();
  // TODO: Implement sendMdmCommand — creates mdm_commands row, calls sidecar
  return c.json({ error: 'Not yet implemented' }, 501);
});

// GET /mdm/devices/:id/commands — list command history for a device
mdmRoutes.get('/devices/:id/commands', requireScope('organization', 'partner', 'system'), requireMdmRead, async (c) => {
  const auth = c.get('auth') as AuthContext;
  const { id } = c.req.param();
  // TODO: Implement listMdmCommands
  return c.json({ commands: [], total: 0 });
});

// GET /mdm/commands/:commandId — get command status
mdmRoutes.get('/commands/:commandId', requireScope('organization', 'partner', 'system'), requireMdmRead, async (c) => {
  const auth = c.get('auth') as AuthContext;
  const { commandId } = c.req.param();
  // TODO: Implement getMdmCommandStatus
  return c.json({ error: 'Not yet implemented' }, 501);
});

// ─── Enrollment ───

// GET /mdm/enroll — get enrollment link/QR data
mdmRoutes.get('/enroll', requireScope('organization', 'partner', 'system'), requireMdmWrite, async (c) => {
  const auth = c.get('auth') as AuthContext;
  // TODO: Generate enrollment URL pointing to sidecar /mdm/enroll endpoint
  return c.json({
    enrollmentUrl: '/mdm/enroll',
    qrData: '',
    instructions: 'Scan the QR code or open the enrollment URL on your Apple device to enroll in Breeze MDM.',
  });
});

// POST /mdm/enroll — generate enrollment token
mdmRoutes.post('/enroll', requireScope('organization', 'partner', 'system'), requireMdmWrite, requireMfa(), async (c) => {
  const auth = c.get('auth') as AuthContext;
  // TODO: Generate enrollment token, return QR/link
  return c.json({ error: 'Not yet implemented' }, 501);
});

// ─── APNs / ABM Configuration ───

// GET /mdm/settings/apns — get APNs configuration
mdmRoutes.get('/settings/apns', requireScope('organization', 'partner', 'system'), requireMdmRead, async (c) => {
  const auth = c.get('auth') as AuthContext;
  // TODO: Fetch from mdm_apns_config
  return c.json({
    configured: false,
    certExpiry: null,
    abmEnabled: false,
    abmLastSync: null,
    scepEnabled: false,
  });
});

// PUT /mdm/settings/apns — update APNs configuration
mdmRoutes.put('/settings/apns', requireScope('organization', 'partner', 'system'), requireMdmWrite, requireMfa(), async (c) => {
  const auth = c.get('auth') as AuthContext;
  // TODO: Accept cert upload (multipart), encrypt, store
  return c.json({ error: 'Not yet implemented' }, 501);
});

// POST /mdm/settings/abm/sync — trigger ABM sync
mdmRoutes.post('/settings/abm/sync', requireScope('organization', 'partner', 'system'), requireMdmWrite, requireMfa(), async (c) => {
  const auth = c.get('auth') as AuthContext;
  // TODO: Call sidecar /internal/abm/sync
  return c.json({ status: 'sync_started' });
});
