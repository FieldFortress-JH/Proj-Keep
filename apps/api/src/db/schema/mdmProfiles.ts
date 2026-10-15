import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, pgEnum, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';
import { devices } from './devices';

export const mdmProfileStatusEnum = pgEnum('mdm_profile_status', ['draft', 'active', 'archived']);

export const mdmProfiles = pgTable('mdm_profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  status: mdmProfileStatusEnum('status').notNull().default('draft'),
  // Apple profile identity
  profileIdentifier: varchar('profile_identifier', { length: 255 }).notNull(),
  profileUuid: uuid('profile_uuid').notNull().defaultRandom(),
  profileDisplayName: varchar('profile_display_name', { length: 255 }).notNull(),
  profileDescription: text('profile_description'),
  profileOrganization: varchar('profile_organization', { length: 255 }),
  profileRemovalDisallowed: boolean('profile_removal_disallowed').default(false),
  // The signed .mobileconfig XML (signed at creation time)
  profilePayload: text('profile_payload').notNull().default(''),
  // Breeze-native structured payloads for UI editing (JSON array)
  payloads: jsonb('payloads').notNull().default([]),
  // Target platforms: ios, ipados, macos
  targetPlatforms: text('target_platforms').array().notNull().default(['ios', 'ipados', 'macos']),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  orgIdx: index('mdm_profiles_org_idx').on(table.orgId),
  identifierIdx: index('mdm_profiles_identifier_idx').on(table.profileIdentifier),
  statusIdx: index('mdm_profiles_status_idx').on(table.status),
}));

// Which devices have which profiles installed (tracked from device check-ins)
export const mdmProfileInstallations = pgTable('mdm_profile_installations', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull().references(() => mdmProfiles.id, { onDelete: 'cascade' }),
  profileUuid: uuid('profile_uuid').notNull(),  // copied from profile for immutability
  installedAt: timestamp('installed_at'),
  verifiedAt: timestamp('verified_at'),  // last time device confirmed installation
  status: varchar('status', { length: 50 }).notNull().default('pending'),
  // pending | installed | failed | removed | verifying
}, (table) => ({
  deviceIdx: index('mdm_profile_installations_device_idx').on(table.deviceId),
  profileIdx: index('mdm_profile_installations_profile_idx').on(table.profileId),
  deviceProfileUniq: uniqueIndex('mdm_profile_installations_device_profile_uniq').on(table.deviceId, table.profileId),
}));
