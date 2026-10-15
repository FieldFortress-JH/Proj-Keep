import { pgTable, uuid, varchar, timestamp, jsonb, pgEnum, index } from 'drizzle-orm/pg-core';
import { users } from './users';
import { devices } from './devices';

export const mdmCommandTypeEnum = pgEnum('mdm_command_type', [
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
]);

export const mdmCommandStatusEnum = pgEnum('mdm_command_status', [
  'pending',
  'queued',
  'sent',
  'acknowledged',
  'error',
  'failed',
  'timeout',
  'cancelled',
]);

export const mdmCommands = pgTable('mdm_commands', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  commandType: mdmCommandTypeEnum('command_type').notNull(),
  commandUuid: uuid('command_uuid').notNull().defaultRandom(),
  status: mdmCommandStatusEnum('status').notNull().default('pending'),
  // Apple MDM command payload (XML/plist structure as JSON)
  payload: jsonb('payload'),
  // Device response
  resultPayload: jsonb('result_payload'),
  errorCode: varchar('error_code', { length: 50 }),
  errorChain: jsonb('error_chain'),
  // Timing
  createdAt: timestamp('created_at').defaultNow().notNull(),
  queuedAt: timestamp('queued_at'),
  sentAt: timestamp('sent_at'),
  acknowledgedAt: timestamp('acknowledged_at'),
  expiresAt: timestamp('expires_at'),
  createdBy: uuid('created_by').references(() => users.id),
}, (table) => ({
  deviceIdx: index('mdm_commands_device_idx').on(table.deviceId),
  statusIdx: index('mdm_commands_status_idx').on(table.status),
  deviceStatusIdx: index('mdm_commands_device_status_idx').on(table.deviceId, table.status),
}));
