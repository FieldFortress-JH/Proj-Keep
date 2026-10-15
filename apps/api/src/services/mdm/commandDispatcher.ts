import { db } from '../../db';
import { mdmCommands, devices } from '../../db/schema';
import { eq, and, desc } from 'drizzle-orm';
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

/**
 * Send an MDM command to a device.
 */
export async function sendMdmCommand(auth: AuthContext, input: SendMdmCommandInput) {
  // Verify device exists and is MDM-enrolled
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

  // Dispatch to sidecar (async — sidecar queues + sends APNs push)
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
    await db
      .update(mdmCommands)
      .set({ status: 'queued', queuedAt: new Date() })
      .where(eq(mdmCommands.id, command.id));

    return { ...command, status: 'queued' as const, sidecarCommandId: result.command_id };
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
 */
export async function listMdmCommands(
  auth: AuthContext,
  deviceId: string,
  filters: { status?: string },
  pagination: { page: number; limit: number },
) {
  const conditions = [
    eq(mdmCommands.deviceId, deviceId),
    eq(devices.orgId, auth.orgId!),
  ];

  if (filters.status) {
    conditions.push(eq(mdmCommands.status, filters.status as typeof mdmCommands.status._.data[number]));
  }

  const results = await db
    .select()
    .from(mdmCommands)
    .innerJoin(devices, eq(mdmCommands.deviceId, devices.id))
    .where(and(...conditions))
    .orderBy(desc(mdmCommands.createdAt))
    .limit(pagination.limit)
    .offset((pagination.page - 1) * pagination.limit);

  return { commands: results, total: results.length, page: pagination.page, limit: pagination.limit };
}

/**
 * Get the status of a specific MDM command.
 * Polls the sidecar for the latest status.
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
      await db
        .update(mdmCommands)
        .set({
          status: sidecarStatus.status as typeof mdmCommands.status._.data[number],
          sentAt: sidecarStatus.sent_at ? new Date(sidecarStatus.sent_at) : undefined,
          acknowledgedAt: sidecarStatus.acknowledged_at ? new Date(sidecarStatus.acknowledged_at) : undefined,
          resultPayload: sidecarStatus.result,
          errorCode: sidecarStatus.error_code,
        })
        .where(eq(mdmCommands.id, commandId));

      return { ...command.mdm_commands, status: sidecarStatus.status };
    }
  } catch {
    // Sidecar unreachable — return cached status
  }

  return command.mdm_commands;
}
