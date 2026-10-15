import type { MdmCommandType } from '@breeze/shared';

/**
 * Sidecar Client — HTTP client for communicating with the MDM sidecar service.
 *
 * The sidecar (apps/mdm-server) is a Go service that wraps NanoMDM and handles
 * the Apple MDM protocol. This client lets the Breeze API talk to it.
 *
 * Configuration:
 *   MDM_SIDECAR_URL — Sidecar base URL (default: http://breeze-mdm:8443)
 */

const SIDECAR_URL = process.env.MDM_SIDECAR_URL || 'http://breeze-mdm:8443';

interface SidecarQueueCommandRequest {
  device_udid: string;
  command_type: MdmCommandType;
  payload?: Record<string, unknown>;
  created_by?: string;
}

interface SidecarQueueCommandResponse {
  command_id: string;
  status: string;
  message?: string;
}

interface SidecarCommandStatus {
  command_id: string;
  status: string;
  sent_at?: string;
  acknowledged_at?: string;
  result?: Record<string, unknown>;
  error_code?: string;
}

/**
 * Send a command to the sidecar for queuing + APNs dispatch.
 */
export async function sendCommandToSidecar(
  req: SidecarQueueCommandRequest,
): Promise<SidecarQueueCommandResponse> {
  const res = await fetch(`${SIDECAR_URL}/internal/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    throw new Error(`Sidecar error: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

/**
 * Get the latest status of a command from the sidecar.
 */
export async function getSidecarCommandStatus(commandId: string): Promise<SidecarCommandStatus> {
  const res = await fetch(`${SIDECAR_URL}/internal/commands/${commandId}`);

  if (!res.ok) {
    throw new Error(`Sidecar error: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

/**
 * List commands for a device from the sidecar.
 */
export async function listSidecarDeviceCommands(udid: string) {
  const res = await fetch(`${SIDECAR_URL}/internal/devices/${udid}/commands`);

  if (!res.ok) {
    throw new Error(`Sidecar error: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

/**
 * Trigger an ABM sync via the sidecar.
 */
export async function triggerABMSync() {
  const res = await fetch(`${SIDECAR_URL}/internal/abm/sync`, { method: 'POST' });

  if (!res.ok) {
    throw new Error(`Sidecar error: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

/**
 * Check if the sidecar is healthy.
 */
export async function checkSidecarHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${SIDECAR_URL}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
