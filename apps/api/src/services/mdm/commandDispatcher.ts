import { db } from '../../db';
import { mdmCommands, devices } from '../../db/schema';
import { eq, and, desc, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { AuthContext } from '../../middleware/auth';
import type { MdmCommandType } from '@breeze/shared';
import { sendCommandToSidecar, getSidecarCommandStatus } from './sidecarClient';

/**
 * Command Dispatcher — queues MDM commands and dispatches them via the sidecar.
 *
 * Flow:
 *   1. Admin sends command via API → create mdm_commands row (status: pending)
 *   2. Call sidecar to queue → sidecar sends APNs push → device wakes up
 *   3. Device checks in → sidecar delivers command → device executes
 *   4. Device sends response → sidecar updates status → API polls/updates
 */

export interface SendMdmCommandInput {
  deviceId: string;
  commandType: MdmCommandType;
  payload?: Record<string, unknown>;
  createdBy?: string;
}

export interface ListMdmCommandsFilters {
  status?: string;
}

/**
 * Send an MDM command to a device.
 *
 * Creates a command record in the DB, then dispatches to the sidecar
 * which queues it and sends an APNs push to wake the device.
 *
 * @throws Error if device not found, not MDM-enrolled, or sidecar unreachable
 */
export async function sendMdmCommand(auth: AuthContext, input: SendMdmCommandInput) {
  // Verify device exists and is MDM-enrolled, scoped to caller's org
  const [device] = await db
    .select()
    .from(devices)
    .where(and(eq(devices.id, input.deviceId), eq(devices.orgId, auth.orgId!)))
    .limit(1);

  if (!device) {
    throw new Error('Device not found');
  }

  if (!device.mdmEnrolled || !device.mdmUdId) {
    throw new Error('Device is not enrolled in MDM');
  }

  // Create command record
  const commandUuid = randomUUID();
  const [command] = await db
    .insert(mdmCommands)
    .values({
      deviceId: input.deviceId,
      commandType: input.commandType,
      commandUuid,
      status: 'pending',
      payload: input.payload,
      createdBy: input.createdBy,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h expiry
    })
    .returning();

  // Dispatch to sidecar (sidecar queues + sends APNs push)
  try {
    const result = await sendCommandToSidecar({
      device_udid: device.mdmUdId,
      command_type: input.commandType,
      payload: {
        ...input.payload,
        command_uuid: commandUuid,
        command_id: command.id,
      },
      created_by: input.createdBy,
    });

    // Update status to queued
    const [updated] = await db
      .update(mdmCommands)
      .set({ status: 'queued', queuedAt: new Date() })
      .where(eq(mdmCommands.id, command.id))
      .returning();

    return { ...updated, sidecarCommandId: result.command_id };
  } catch (err) {
    // Mark as failed if sidecar is unreachable
    await db
      .update(mdmCommands)
      .set({ status: 'failed', errorCode: 'SIDECAR_UNREACHABLE' })
      .where(eq(mdmCommands.id, command.id));

    throw err;
  }
}

/**
 * List MDM commands for a device.
 * Scoped to caller's org. Supports filtering by status and pagination.
 */
export async function listMdmCommands(
  auth: AuthContext,
  deviceId: string,
  filters: ListMdmCommandsFilters,
  pagination: { page: number; limit: number },
) {
  // Verify device belongs to org first
  const [device] = await db
    .select()
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, auth.orgId!)))
    .limit(1);

  if (!device) {
    throw new Error('Device not found');
  }

  const conditions = [eq(mdmCommands.deviceId, deviceId)];

  if (filters.status) {
    conditions.push(eq(mdmCommands.status, filters.status as typeof mdmCommands.status._.data[number]));
  }

  // Get total count for pagination
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(mdmCommands)
    .where(and(...conditions));

  const results = await db
    .select({
      command: mdmCommands,
      deviceHostname: devices.hostname,
      deviceDisplayName: devices.displayName,
    })
    .from(mdmCommands)
    .innerJoin(devices, eq(mdmCommands.deviceId, devices.id))
    .where(and(...conditions))
    .orderBy(desc(mdmCommands.createdAt))
    .limit(pagination.limit)
    .offset((pagination.page - 1) * pagination.limit);

  return {
    commands: results.map((r) => r.command),
    total: count,
    page: pagination.page,
    limit: pagination.limit,
  };
}

/**
 * Get the status of a specific MDM command.
 * Polls the sidecar for the latest status and syncs to local DB.
 * Scoped to caller's org.
 */
export async function getMdmCommand(auth: AuthContext, commandId: string) {
  const [command] = await db
    .select()
    .from(mdmCommands)
    .innerJoin(devices, eq(mdmCommands.deviceId, devices.id))
    .where(and(eq(mdmCommands.id, commandId), eq(devices.orgId, auth.orgId!)))
    .limit(1);

  if (!command) {
    throw new Error('Command not found');
  }

  // Poll sidecar for latest status
  try {
    const sidecarStatus = await getSidecarCommandStatus(commandId);
    if (sidecarStatus.status !== command.mdm_commands.status) {
      // Update local status from sidecar
      const [updated] = await db
        .update(mdmCommands)
        .set({
          status: sidecarStatus.status as typeof mdmCommands.status._.data[number],
          sentAt: sidecarStatus.sent_at ? new Date(sidecarStatus.sent_at) : undefined,
          acknowledgedAt: sidecarStatus.acknowledged_at ? new Date(sidecarStatus.acknowledged_at) : undefined,
          resultPayload: sidecarStatus.result,
          errorCode: sidecarStatus.error_code,
        })
        .where(eq(mdmCommands.id, commandId))
        .returning();

      return updated;
    }
  } catch {
    // Sidecar unreachable — return cached status
  }

  return command.mdm_commands;
}

/**
 * Cancel a pending MDM command.
 * Only works for commands that haven't been sent yet (status: pending/queued).
 */
export async function cancelMdmCommand(auth: AuthContext, commandId: string) {
  const [command] = await db
    .select()
    .from(mdmCommands)
    .innerJoin(devices, eq(mdmCommands.deviceId, devices.id))
    .where(and(eq(mdmCommands.id, commandId), eq(devices.orgId, auth.orgId!)))
    .limit(1);

  if (!command) {
    throw new Error('Command not found');
  }

  if (!['pending', 'queued'].includes(command.mdm_commands.status)) {
    throw new Error(`Cannot cancel command in status: ${command.mdm_commands.status}`);
  }

  const [cancelled] = await db
    .update(mdmCommands)
    .set({ status: 'cancelled' })
    .where(eq(mdmCommands.id, commandId))
    .returning();

  return cancelled;
}
