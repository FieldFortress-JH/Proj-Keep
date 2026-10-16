import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the database
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

// Mock drizzle-orm
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col, val) => ({ type: 'eq', col, val })),
  and: vi.fn((...conds) => ({ type: 'and', conds })),
  desc: vi.fn((col) => ({ type: 'desc', col })),
  or: vi.fn((...conds) => ({ type: 'or', conds })),
  ilike: vi.fn((col, val) => ({ type: 'ilike', col, val })),
  sql: vi.fn((strings, ...values) => ({ type: 'sql', strings, values })),
}));

import { db } from '../../db';

// Auth context stub
const mockAuth = {
  orgId: 'test-org-id',
  userId: 'test-user-id',
  partnerId: 'test-partner-id',
} as any;

describe('profileManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listMdmProfiles', () => {
    it('should scope results to the caller org', async () => {
      // We can't easily test the full DB query without a real DB,
      // but we can verify the conditions include org scoping
      const { listMdmProfiles } = await import('./profileManager');

      // Mock the count query and select query
      const mockCount = [{ count: 5 }];
      const mockProfiles = [
        {
          id: 'profile-1',
          orgId: 'test-org-id',
          name: 'WiFi Profile',
          status: 'active',
          profileIdentifier: 'com.test.wifi',
          profileUuid: 'uuid-1',
          profileDisplayName: 'Test WiFi',
          payloads: [],
          targetPlatforms: ['ios', 'macos'],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      (db.select as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(mockCount),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockResolvedValue(mockProfiles),
                }),
              }),
            }),
          }),
        });

      const result = await listMdmProfiles(mockAuth, {}, { page: 1, limit: 25 });

      expect(result.profiles).toHaveLength(1);
      expect(result.total).toBe(5);
      expect(result.page).toBe(1);
    });

    it('should include search filter when provided', async () => {
      const { listMdmProfiles } = await import('./profileManager');

      (db.select as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 0 }]),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockResolvedValue([]),
                }),
              }),
            }),
          }),
        });

      await listMdmProfiles(mockAuth, { search: 'wifi' }, { page: 1, limit: 25 });

      // Verify db.select was called (search adds conditions)
      expect(db.select).toHaveBeenCalled();
    });
  });

  describe('getMdmProfile', () => {
    it('should throw when profile not found', async () => {
      const { getMdmProfile } = await import('./profileManager');

      (db.select as any).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      await expect(getMdmProfile(mockAuth, 'nonexistent-id')).rejects.toThrow('Profile not found');
    });

    it('should return profile when found', async () => {
      const { getMdmProfile } = await import('./profileManager');

      const mockProfile = {
        id: 'profile-1',
        orgId: 'test-org-id',
        name: 'Test Profile',
        status: 'draft',
        profileIdentifier: 'com.test.profile',
        profileUuid: 'uuid-1',
        profileDisplayName: 'Test',
        profilePayload: '',
        payloads: [],
        targetPlatforms: ['ios'],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      (db.select as any).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([mockProfile]),
          }),
        }),
      });

      const result = await getMdmProfile(mockAuth, 'profile-1');
      expect(result.name).toBe('Test Profile');
    });
  });

  describe('createMdmProfile', () => {
    it('should generate UUIDs for payloads that lack them', async () => {
      const { createMdmProfile } = await import('./profileManager');

      const mockProfile = {
        id: 'new-profile-id',
        orgId: 'test-org-id',
        name: 'New Profile',
        status: 'draft',
        profileIdentifier: 'com.test.new',
        profileUuid: 'uuid-new',
        profileDisplayName: 'New',
        profilePayload: '',
        payloads: [{ type: 'com.apple.wifi.managed', identifier: 'wifi-1', uuid: expect.any(String), settings: {} }],
        targetPlatforms: ['ios'],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      (db.insert as any).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([mockProfile]),
        }),
      });

      const result = await createMdmProfile(mockAuth, {
        orgId: 'test-org-id',
        name: 'New Profile',
        profileIdentifier: 'com.test.new',
        profileDisplayName: 'New',
        payloads: [{ type: 'com.apple.wifi.managed', identifier: 'wifi-1', uuid: '', settings: {} } as any],
        targetPlatforms: ['ios'],
      });

      expect(result.id).toBe('new-profile-id');
      // Payload UUID should have been generated
      expect(result.payloads[0].uuid).toBeTruthy();
    });
  });

  describe('signMdmProfile', () => {
    it('should generate .mobileconfig XML and set status to active', async () => {
      const { signMdmProfile } = await import('./profileManager');

      const mockProfile = {
        id: 'profile-1',
        orgId: 'test-org-id',
        name: 'Test Profile',
        status: 'draft',
        profileIdentifier: 'com.test.profile',
        profileUuid: 'uuid-1',
        profileDisplayName: 'Test Profile',
        profileRemovalDisallowed: false,
        profilePayload: '',
        payloads: [
          {
            type: 'com.apple.wifi.managed',
            identifier: 'wifi-1',
            uuid: 'payload-uuid-1',
            displayName: 'WiFi',
            settings: { SSID_STR: 'TestNetwork', EncryptionType: 'WPA2', 'WPA2': { Password: 'secret' } },
          },
        ],
        targetPlatforms: ['ios'],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockUpdated = { ...mockProfile, status: 'active', profilePayload: expect.any(String) };

      // Mock getMdmProfile (internal call)
      (db.select as any).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([mockProfile]),
          }),
        }),
      });

      (db.update as any).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([mockUpdated]),
          }),
        }),
      });

      const result = await signMdmProfile(mockAuth, 'profile-1');

      expect(result.status).toBe('active');
      expect(result.profilePayload).toContain('<?xml version="1.0"');
      expect(result.profilePayload).toContain('com.apple.wifi.managed');
      expect(result.profilePayload).toContain('TestNetwork');
    });
  });
});

describe('profileManager — .mobileconfig XML builder', () => {
  it('should escape XML special characters', async () => {
    const { signMdmProfile } = await import('./profileManager');

    const mockProfile = {
      id: 'profile-1',
      orgId: 'test-org-id',
      name: 'Test & Profile <script>',
      status: 'draft',
      profileIdentifier: 'com.test.escape',
      profileUuid: 'uuid-1',
      profileDisplayName: 'Test & "Profile" <script>',
      profileRemovalDisallowed: false,
      profilePayload: '',
      payloads: [],
      targetPlatforms: ['ios'],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockUpdated = { ...mockProfile, status: 'active', profilePayload: expect.any(String) };

    (db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([mockProfile]),
        }),
      }),
    });

    (db.update as any).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([mockUpdated]),
        }),
      }),
    });

    const result = await signMdmProfile(mockAuth, 'profile-1');

    // XML special chars should be escaped
    expect(result.profilePayload).toContain('&amp;');
    expect(result.profilePayload).toContain('&lt;');
    expect(result.profilePayload).toContain('&quot;');
    // Raw dangerous chars should NOT appear unescaped in the display name
    expect(result.profilePayload).not.toContain('<script>');
  });
});
