import { pgTable, uuid, varchar, text, timestamp, boolean, unique } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';

export const mdmApnsConfig = pgTable('mdm_apns_config', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  // APNs certificate (encrypted at rest)
  apnsCertEncrypted: text('apns_cert_encrypted'),
  apnsKeyEncrypted: text('apns_key_encrypted'),
  apnsTopic: varchar('apns_topic', { length: 255 }),
  apnsUseTokenAuth: boolean('apns_use_token_auth').default(false),
  apnsPushCertExpiry: timestamp('apns_push_cert_expiry'),
  // Apple Business Manager
  abmTokenEncrypted: text('abm_token_encrypted'),
  abmTokenExpiry: timestamp('abm_token_expiry'),
  abmEnabled: boolean('abm_enabled').default(false),
  abmLastSync: timestamp('abm_last_sync'),
  // SCEP configuration for device certificates
  scepEnabled: boolean('scep_enabled').default(false),
  scepCaFingerprint: varchar('scep_ca_fingerprint', { length: 255 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  orgUnique: unique('mdm_apns_config_org_unique').on(table.orgId),
}));
