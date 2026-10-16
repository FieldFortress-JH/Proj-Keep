import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('./sidecarClient', () => ({
  sendCommandToSidecar: vi.fn(),
  getSidecarCommandStatus: vi.fn(),
}));

import { db } from '../../db';
import { sendCommandToSidecar } from './sidecarClient';

const mockAuth = {
  orgId: 'test-org-id',
  userId: 'test-user-id',
} as any;

describe('commandDispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('sendMdmCommand', () => {
    it('should throw when device not found', async () => {
      const { sendMdmCommand } = await import('./commandDispatcher');

      (db.select as any).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      await expect(
        sendMdmCommand(mockAuth, { deviceId: 'nonexistent', commandType: 'device_lock' })
      ).rejects.toThrow('Device not found');
    });

    it('should throw when device is not MDM-enrolled', async () => {
      const { sendMdmCommand } = await import('./commandDispatcher');

      (db.select as any).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'device-1',
              orgId: 'test-org-id',
              mdmEnrolled: false,
              mdmUdId: null,
            }]),
          }),
        }),
      });

      await expect(
        sendMdmCommand(mockAuth, { deviceId: 'device-1', commandType: 'device_lock' })
      ).rejects.toThrow('Device is not enrolled in MDM');
    });

    it('should create command and dispatch to sidecar', async () => {
      const { sendMdmCommand } = await import('./commandDispatcher');

      const mockDevice = {
        id: 'device-1',
        orgId: 'test-org-id',
        mdmEnrolled: true,
        mdmUdId: 'test-udid-123',
      };

      const mockCommand = {
        id: 'cmd-1',
        deviceId: 'device-1',
        commandType: 'device_lock',
        commandUuid: 'uuid-cmd-1',
        status: 'pending',
        createdAt: new Date(),
      };

      // Mock device lookup
      (db.select as any).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([mockDevice]),
          }),
        }),
      });

      // Mock command insert
      (db.insert as any).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([mockCommand]),
        }),
      });

      // Mock sidecar call
      (sendCommandToSidecar as any).mockResolvedValue({
        command_id: 'sidecar-cmd-1',
        status: 'queued',
      });

      // Mock status update
      (db.update as any).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ ...mockCommand, status: 'queued' }]),
          }),
        }),
      });

      const result = await sendMdmCommand(mockAuth, {
        deviceId: 'device-1',
        commandType: 'device_lock',
        createdBy: 'test-user-id',
      });

      expect(result.status).toBe('queued');
      expect(result.sidecarCommandId).toBe('sidecar-cmd-1');
      expect(sendCommandToSidecar).toHaveBeenCalledWith(
        expect.objectContaining({
          device_udid: 'test-udid-123',
          command_type: 'device_lock',
        })
      );
    });

    it('should mark command as failed when sidecar is unreachable', async () => {
      const { sendMdmCommand } = await import('./commandDispatcher');

      const mockDevice = {
        id: 'device-1',
        orgId: 'test-org-id',
        mdmEnrolled: true,
        mdmUdId: 'test-udid-123',
      };

      (db.select as any).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([mockDevice]),
          }),
        }),
      });

      (db.insert as any).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'cmd-1', status: 'pending' }]),
        }),
      });

      (sendCommandToSidecar as any).mockRejectedValue(new Error('Connection refused'));

      (db.update as any).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      await expect(
        sendMdmCommand(mockAuth, { deviceId: 'device-1', commandType: 'device_lock' })
      ).rejects.toThrow('Connection refused');

      // Verify the command was marked as failed
      expect(db.update).toHaveBeenCalled();
    });
  });

  describe('listMdmCommands', () => {
    it('should verify device belongs to org before listing commands', async () => {
      const { listMdmCommands } = await import('./commandDispatcher');

      // Device not found
      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      await expect(
        listMdmCommands(mockAuth, 'nonexistent-device', {}, { page: 1, limit: 25 })
      ).rejects.toThrow('Device not found');
    });
  });

  describe('cancelMdmCommand', () => {
    it('should throw when command is already sent', async () => {
      const { cancelMdmCommand } = await import('./commandDispatcher');

      (db.select as any).mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                mdm_commands: { id: 'cmd-1', status: 'sent' },
              }]),
            }),
          }),
        }),
      });

      await expect(
        cancelMdmCommand(mockAuth, 'cmd-1')
      ).rejects.toThrow('Cannot cancel command in status: sent');
    });

    it('should cancel a pending command', async () => {
      const { cancelMdmCommand } = await import('./commandDispatcher');

      (db.select as any).mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                mdm_commands: { id: 'cmd-1', status: 'pending' },
              }]),
            }),
          }),
        }),
      });

      (db.update as any).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'cmd-1', status: 'cancelled' }]),
          }),
        }),
      });

      const result = await cancelMdmCommand(mockAuth, 'cmd-1');
      expect(result.status).toBe('cancelled');
    });
  });
});
