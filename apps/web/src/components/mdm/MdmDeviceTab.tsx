import { useState, useEffect } from "react";
import {
  Smartphone,
  Lock,
  Trash2,
  RotateCw,
  Power,
  KeyRound,
  FileText,
  Shield,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Send,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchWithAuth } from "@/stores/auth";
import { showToast } from "../shared/Toast";
import { ConfirmDialog } from "../shared/ConfirmDialog";

// ─── Types ───

interface MdmDeviceInfo {
  mdmEnrolled: boolean;
  mdmUdId?: string;
  mdmSerialNumber?: string;
  mdmProduct?: string;
  mdmModelName?: string;
  mdmSupervised: boolean;
  mdmActivationLockEnabled: boolean;
  mdmLastCheckin?: string;
  mdmEnrollmentType: string;
}

interface MdmProfileInstallation {
  id: string;
  profileId: string;
  profileUuid: string;
  profileName?: string;
  status: string;
  installedAt?: string;
  verifiedAt?: string;
}

interface MdmCommand {
  id: string;
  commandType: string;
  commandUuid: string;
  status: string;
  createdAt: string;
  sentAt?: string;
  acknowledgedAt?: string;
  errorCode?: string;
}

interface MdmDeviceTabProps {
  deviceId: string;
  device: {
    id: string;
    hostname: string;
    osType: string;
    mdmEnrolled?: boolean;
    mdmUdId?: string;
    mdmModelName?: string;
    mdmSupervised?: boolean;
    mdmLastCheckin?: string;
    mdmEnrollmentType?: string;
  };
}

// ─── Command definitions ───

const COMMANDS = [
  { type: "device_lock", label: "Lock Device", icon: Lock, variant: "warning" as const, confirm: true, description: "Lock the device screen" },
  { type: "clear_passcode", label: "Clear Passcode", icon: KeyRound, variant: "warning" as const, confirm: true, description: "Remove the device passcode" },
  { type: "restart_device", label: "Restart", icon: RotateCw, variant: "default" as const, confirm: true, description: "Restart the device" },
  { type: "shutdown_device", label: "Shutdown", icon: Power, variant: "default" as const, confirm: true, description: "Shut down the device" },
  { type: "device_wipe", label: "Wipe Device", icon: Trash2, variant: "destructive" as const, confirm: true, description: "Erase all data (IRREVERSIBLE)" },
] as const;

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: typeof CheckCircle2 }> = {
  pending: { label: "Pending", color: "text-muted-foreground", icon: Clock },
  queued: { label: "Queued", color: "text-primary", icon: Clock },
  sent: { label: "Sent", color: "text-primary", icon: Send },
  acknowledged: { label: "Acknowledged", color: "text-success", icon: CheckCircle2 },
  error: { label: "Error", color: "text-destructive", icon: XCircle },
  failed: { label: "Failed", color: "text-destructive", icon: XCircle },
  timeout: { label: "Timeout", color: "text-warning", icon: AlertTriangle },
  cancelled: { label: "Cancelled", color: "text-muted-foreground", icon: XCircle },
};

function commandTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    install_profile: "Install Profile",
    remove_profile: "Remove Profile",
    device_lock: "Lock Device",
    device_wipe: "Wipe Device",
    clear_passcode: "Clear Passcode",
    restart_device: "Restart",
    shutdown_device: "Shutdown",
    os_update: "OS Update",
    install_app: "Install App",
    remove_app: "Remove App",
    device_information: "Query Info",
    profile_list: "List Profiles",
    security_info: "Security Info",
    certificate_list: "List Certificates",
  };
  return labels[type] || type;
}

// ─── Main Component ───

export default function MdmDeviceTab({ deviceId, device }: MdmDeviceTabProps) {
  const [profiles, setProfiles] = useState<MdmProfileInstallation[]>([]);
  const [commands, setCommands] = useState<MdmCommand[]>([]);
  const [loading, setLoading] = useState(true);
  const [sendingCommand, setSendingCommand] = useState<string | null>(null);
  const [confirmCommand, setConfirmCommand] = useState<string | null>(null);

  const isMdmEnrolled = device.mdmEnrolled ?? false;

  const loadData = async () => {
    setLoading(true);
    try {
      const [profilesRes, commandsRes] = await Promise.all([
        fetchWithAuth(`/api/v1/mdm/devices/${deviceId}/profiles`),
        fetchWithAuth(`/api/v1/mdm/devices/${deviceId}/commands?limit=20`),
      ]);
      if (profilesRes.ok) {
        const data = await profilesRes.json();
        setProfiles(data.installations || []);
      }
      if (commandsRes.ok) {
        const data = await commandsRes.json();
        setCommands(data.commands || []);
      }
    } catch {
      // API not ready
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isMdmEnrolled) {
      loadData();
    } else {
      setLoading(false);
    }
  }, [deviceId, isMdmEnrolled]);

  const sendCommand = async (commandType: string) => {
    setSendingCommand(commandType);
    setConfirmCommand(null);
    try {
      const res = await fetchWithAuth(`/api/v1/mdm/devices/${deviceId}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandType }),
      });
      if (res.ok) {
        showToast("Command sent", "success");
        loadData();
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || "Failed to send command", "error");
      }
    } catch {
      showToast("Failed to send command", "error");
    } finally {
      setSendingCommand(null);
    }
  };

  // Not MDM-enrolled — show enrollment prompt
  if (!isMdmEnrolled) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <Smartphone className="h-12 w-12 text-muted-foreground mb-4" />
        <h3 className="text-lg font-medium mb-2">Not enrolled in MDM</h3>
        <p className="text-sm text-muted-foreground max-w-md mb-4">
          This device is managed by the Breeze agent but is not enrolled in Apple MDM.
          {device.osType === "macos" && " macOS devices can be enrolled via MDM for additional management capabilities like configuration profiles and remote commands."}
        </p>
        <a
          href="/mdm-profiles"
          className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90"
        >
          <Smartphone className="h-4 w-4" />
          Go to MDM Profiles
        </a>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Device MDM Info */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="rounded-lg border border-border p-3">
          <div className="text-xs text-muted-foreground mb-1">Model</div>
          <div className="text-sm font-medium">{device.mdmModelName || "—"}</div>
        </div>
        <div className="rounded-lg border border-border p-3">
          <div className="text-xs text-muted-foreground mb-1">Supervised</div>
          <div className="text-sm font-medium flex items-center gap-1">
            {device.mdmSupervised ? (
              <><CheckCircle2 className="h-3.5 w-3.5 text-success" /> Yes</>
            ) : (
              <><XCircle className="h-3.5 w-3.5 text-muted-foreground" /> No</>
            )}
          </div>
        </div>
        <div className="rounded-lg border border-border p-3">
          <div className="text-xs text-muted-foreground mb-1">Last Check-in</div>
          <div className="text-sm font-medium">
            {device.mdmLastCheckin
              ? new Date(device.mdmLastCheckin).toLocaleString()
              : "—"}
          </div>
        </div>
        <div className="rounded-lg border border-border p-3">
          <div className="text-xs text-muted-foreground mb-1">Enrollment</div>
          <div className="text-sm font-medium capitalize">
            {(device.mdmEnrollmentType || "manual").replace(/_/g, " ")}
          </div>
        </div>
      </div>

      {/* Quick Commands */}
      <div className="rounded-lg border border-border p-4">
        <h3 className="font-medium mb-3 flex items-center gap-2">
          <Send className="h-4 w-4" />
          Device Commands
        </h3>
        <div className="flex flex-wrap gap-2">
          {COMMANDS.map((cmd) => {
            const Icon = cmd.icon;
            const isLoading = sendingCommand === cmd.type;
            return (
              <button
                key={cmd.type}
                onClick={() => cmd.confirm ? setConfirmCommand(cmd.type) : sendCommand(cmd.type)}
                disabled={isLoading}
                title={cmd.description}
                className={cn(
                  "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm border transition-colors disabled:opacity-50",
                  cmd.variant === "destructive"
                    ? "border-destructive/30 text-destructive hover:bg-destructive/10"
                    : cmd.variant === "warning"
                    ? "border-warning/30 text-warning hover:bg-warning/10"
                    : "border-border hover:bg-muted"
                )}
              >
                {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
                {cmd.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Installed Profiles */}
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-medium flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Installed Profiles ({profiles.length})
          </h3>
          <button
            onClick={loadData}
            className="p-1 rounded hover:bg-muted"
            title="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
        {profiles.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No profiles installed. Assign profiles via{" "}
            <a href="/configuration-policies" className="text-primary underline">Configuration Policies</a>.
          </p>
        ) : (
          <div className="space-y-2">
            {profiles.map((p) => (
              <div key={p.id} className="flex items-center justify-between p-2 rounded-md border border-border">
                <div>
                  <div className="text-sm font-medium">{p.profileName || p.profileUuid}</div>
                  <div className="text-xs text-muted-foreground">UUID: {p.profileUuid}</div>
                </div>
                <span className={cn(
                  "inline-flex items-center px-2 py-0.5 rounded-full text-xs border",
                  p.status === "installed" ? "bg-success/15 text-success border-success/30" :
                  p.status === "failed" ? "bg-destructive/15 text-destructive border-destructive/30" :
                  "bg-muted text-muted-foreground border-border"
                )}>
                  {p.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Command History */}
      <div className="rounded-lg border border-border p-4">
        <h3 className="font-medium mb-3 flex items-center gap-2">
          <Clock className="h-4 w-4" />
          Command History
        </h3>
        {commands.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No commands sent yet</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="pb-2 font-medium">Command</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium">Sent</th>
                  <th className="pb-2 font-medium">Acknowledged</th>
                </tr>
              </thead>
              <tbody>
                {commands.map((cmd) => {
                  const statusConfig = STATUS_CONFIG[cmd.status] || STATUS_CONFIG.pending;
                  const StatusIcon = statusConfig.icon;
                  return (
                    <tr key={cmd.id} className="border-t border-border">
                      <td className="py-2">{commandTypeLabel(cmd.commandType)}</td>
                      <td className="py-2">
                        <span className={cn("inline-flex items-center gap-1", statusConfig.color)}>
                          <StatusIcon className="h-3.5 w-3.5" />
                          {statusConfig.label}
                        </span>
                      </td>
                      <td className="py-2 text-muted-foreground">
                        {cmd.sentAt ? new Date(cmd.sentAt).toLocaleString() : "—"}
                      </td>
                      <td className="py-2 text-muted-foreground">
                        {cmd.acknowledgedAt ? new Date(cmd.acknowledgedAt).toLocaleString() : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Confirm Dialog */}
      <ConfirmDialog
        open={confirmCommand !== null}
        title={`Send: ${COMMANDS.find((c) => c.type === confirmCommand)?.label || confirmCommand}`}
        message={
          confirmCommand === "device_wipe"
            ? "This will ERASE ALL DATA on the device. This action is IRREVERSIBLE. Are you sure?"
            : `Send "${COMMANDS.find((c) => c.type === confirmCommand)?.label}" to ${device.hostname}?`
        }
        confirmLabel="Send Command"
        variant={confirmCommand === "device_wipe" ? "destructive" : "default"}
        onConfirm={() => confirmCommand && sendCommand(confirmCommand)}
        onCancel={() => setConfirmCommand(null)}
      />
    </div>
  );
}
