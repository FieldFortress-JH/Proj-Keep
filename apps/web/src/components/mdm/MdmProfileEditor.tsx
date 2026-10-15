import { useState, useEffect } from "react";
import {
  ArrowLeft,
  Plus,
  Trash2,
  Wifi,
  Lock,
  Shield,
  Globe,
  Save,
  FileText,
  Smartphone,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchWithAuth } from "@/stores/auth";
import { showToast } from "../shared/Toast";
import { navigateTo } from "@/lib/navigation";

// ─── Types ───

type MdmTargetPlatform = "ios" | "ipados" | "macos";

interface Payload {
  type: string;
  identifier: string;
  displayName: string;
  settings: Record<string, unknown>;
}

// ─── Available payload types ───

const PAYLOAD_TYPES = [
  { type: "com.apple.wifi.managed", label: "Wi-Fi", icon: Wifi, description: "Configure Wi-Fi networks" },
  { type: "com.apple.mobiledevice.passwordpolicy", label: "Passcode", icon: Lock, description: "Enforce passcode requirements" },
  { type: "com.apple.application.access", label: "Restrictions", icon: Shield, description: "Block/allow apps and features" },
  { type: "com.apple.vpn.managed", label: "VPN", icon: Globe, description: "Configure VPN connections" },
  { type: "com.apple.security.pem", label: "Certificate", icon: Lock, description: "Deploy certificates" },
  { type: "com.apple.webclip.managed", label: "Web Clip", icon: Globe, description: "Add home screen shortcuts" },
  { type: "com.apple.softwareupdate.enforcement", label: "OS Update", icon: Smartphone, description: "Enforce OS updates" },
  { type: "com.apple.systempreferences", label: "System Preferences", icon: Shield, description: "macOS system settings" },
];

function payloadTypeMeta(type: string) {
  return PAYLOAD_TYPES.find((p) => p.type === type) || {
    type,
    label: type.split(".").pop() || type,
    icon: FileText,
    description: "",
  };
}

// ─── Profile Editor ───

export default function MdmProfileEditor({ profileId }: { profileId?: string }) {
  const isNew = !profileId;

  // Profile metadata
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [identifier, setIdentifier] = useState("com.breeze.mdm.");
  const [displayName, setDisplayName] = useState("");
  const [organization, setOrganization] = useState("");
  const [removalDisallowed, setRemovalDisallowed] = useState(true);
  const [targetPlatforms, setTargetPlatforms] = useState<MdmTargetPlatform[]>(["ios", "ipados", "macos"]);

  // Payloads
  const [payloads, setPayloads] = useState<Payload[]>([]);
  const [showPayloadPicker, setShowPayloadPicker] = useState(false);

  // UI state
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(!isNew);

  // Load existing profile
  useEffect(() => {
    if (isNew) return;
    (async () => {
      try {
        const res = await fetchWithAuth(`/api/v1/mdm/profiles/${profileId}`);
        if (res.ok) {
          const data = await res.json();
          setName(data.name || "");
          setDescription(data.description || "");
          setIdentifier(data.profileIdentifier || "com.breeze.mdm.");
          setDisplayName(data.profileDisplayName || "");
          setOrganization(data.profileOrganization || "");
          setRemovalDisallowed(data.profileRemovalDisallowed ?? true);
          setTargetPlatforms(data.targetPlatforms || ["ios", "ipados", "macos"]);
          setPayloads(data.payloads || []);
        }
      } catch {
        showToast("Failed to load profile", "error");
      } finally {
        setLoading(false);
      }
    })();
  }, [profileId, isNew]);

  const addPayload = (type: string) => {
    const meta = payloadTypeMeta(type);
    const newPayload: Payload = {
      type,
      identifier: `${identifier}.${type.split(".").pop()}.${Date.now().toString(36)}`,
      displayName: meta.label,
      settings: getDefaultSettings(type),
    };
    setPayloads([...payloads, newPayload]);
    setShowPayloadPicker(false);
  };

  const removePayload = (index: number) => {
    setPayloads(payloads.filter((_, i) => i !== index));
  };

  const updatePayload = (index: number, updates: Partial<Payload>) => {
    setPayloads(payloads.map((p, i) => (i === index ? { ...p, ...updates } : p)));
  };

  const togglePlatform = (platform: MdmTargetPlatform) => {
    setTargetPlatforms((prev) =>
      prev.includes(platform)
        ? prev.filter((p) => p !== platform)
        : [...prev, platform]
    );
  };

  const handleSave = async (activate = false) => {
    if (!name.trim()) {
      showToast("Profile name is required", "error");
      return;
    }
    if (!identifier.trim()) {
      showToast("Profile identifier is required", "error");
      return;
    }
    if (payloads.length === 0) {
      showToast("Add at least one payload", "error");
      return;
    }

    setSaving(true);
    try {
      const body = {
        name,
        description,
        profileIdentifier: identifier,
        profileDisplayName: displayName || name,
        profileDescription: description,
        profileOrganization: organization,
        profileRemovalDisallowed: removalDisallowed,
        payloads,
        targetPlatforms,
      };

      const url = isNew
        ? "/api/v1/mdm/profiles"
        : `/api/v1/mdm/profiles/${profileId}`;
      const method = isNew ? "POST" : "PUT";

      const res = await fetchWithAuth(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const saved = await res.json();
        showToast(isNew ? "Profile created" : "Profile saved", "success");

        if (activate) {
          // Sign and activate
          await fetchWithAuth(`/api/v1/mdm/profiles/${saved.id}/sign`, { method: "POST" });
          showToast("Profile activated", "success");
        }

        navigateTo("/mdm-profiles");
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || "Failed to save profile", "error");
      }
    } catch {
      showToast("Failed to save profile", "error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="p-8 text-center text-muted-foreground">Loading profile...</div>;
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigateTo("/mdm-profiles")}
          className="p-1.5 rounded hover:bg-muted"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div>
          <h1 className="text-2xl font-semibold">
            {isNew ? "New MDM Profile" : `Edit: ${name}`}
          </h1>
          <p className="text-sm text-muted-foreground">
            Apple configuration profile for managed devices
          </p>
        </div>
      </div>

      {/* Profile metadata */}
      <div className="rounded-lg border border-border p-6 space-y-4">
        <h2 className="font-medium">Profile Information</h2>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Name *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Corporate Wi-Fi"
              className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Display Name</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Shown on device (defaults to Name)"
              className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Identifier *</label>
          <input
            type="text"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="com.breeze.mdm.wifi"
            className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm font-mono"
          />
          <p className="text-xs text-muted-foreground mt-1">Reverse-DNS format, unique per profile</p>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this profile does..."
            rows={2}
            className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Organization</label>
            <input
              type="text"
              value={organization}
              onChange={(e) => setOrganization(e.target.value)}
              placeholder="Your company name"
              className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Target Platforms</label>
            <div className="flex gap-2 mt-2">
              {(["ios", "ipados", "macos"] as MdmTargetPlatform[]).map((platform) => (
                <button
                  key={platform}
                  onClick={() => togglePlatform(platform)}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-sm border transition-colors",
                    targetPlatforms.includes(platform)
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background border-border hover:bg-muted"
                  )}
                >
                  {platform === "ios" ? "iOS" : platform === "ipados" ? "iPadOS" : "macOS"}
                </button>
              ))}
            </div>
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={removalDisallowed}
            onChange={(e) => setRemovalDisallowed(e.target.checked)}
            className="rounded border-border"
          />
          Prevent profile removal (requires admin password to remove)
        </label>
      </div>

      {/* Payloads */}
      <div className="rounded-lg border border-border p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Payloads ({payloads.length})</h2>
          <button
            onClick={() => setShowPayloadPicker(!showPayloadPicker)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-md text-sm hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            Add Payload
          </button>
        </div>

        {/* Payload type picker */}
        {showPayloadPicker && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 p-4 rounded-lg bg-muted/50 border border-border">
            {PAYLOAD_TYPES.map((pt) => {
              const Icon = pt.icon;
              return (
                <button
                  key={pt.type}
                  onClick={() => addPayload(pt.type)}
                  className="flex flex-col items-center gap-1 p-3 rounded-lg border border-border bg-background hover:bg-muted text-center"
                >
                  <Icon className="h-5 w-5 text-primary" />
                  <span className="text-sm font-medium">{pt.label}</span>
                  <span className="text-xs text-muted-foreground">{pt.description}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Payload list */}
        {payloads.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No payloads yet. Click "Add Payload" to configure Wi-Fi, passcode, restrictions, etc.
          </p>
        ) : (
          <div className="space-y-3">
            {payloads.map((payload, index) => (
              <PayloadEditor
                key={index}
                payload={payload}
                onUpdate={(updates) => updatePayload(index, updates)}
                onRemove={() => removePayload(index)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-3 pb-8">
        <button
          onClick={() => navigateTo("/mdm-profiles")}
          className="px-4 py-2 rounded-md border border-border text-sm hover:bg-muted"
        >
          Cancel
        </button>
        <button
          onClick={() => handleSave(false)}
          disabled={saving}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-border text-sm hover:bg-muted disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          Save as Draft
        </button>
        <button
          onClick={() => handleSave(true)}
          disabled={saving}
          className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          Save & Activate
        </button>
      </div>
    </div>
  );
}

// ─── Payload Editor (per-payload settings form) ───

function PayloadEditor({
  payload,
  onUpdate,
  onRemove,
}: {
  payload: Payload;
  onUpdate: (updates: Partial<Payload>) => void;
  onRemove: () => void;
}) {
  const meta = payloadTypeMeta(payload.type);
  const Icon = meta.icon;

  return (
    <div className="rounded-lg border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-primary" />
          <span className="font-medium text-sm">{payload.displayName || meta.label}</span>
          <span className="text-xs text-muted-foreground font-mono">{payload.type}</span>
        </div>
        <button
          onClick={onRemove}
          className="p-1 rounded hover:bg-destructive/10 text-destructive"
          title="Remove payload"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      {/* Payload-specific settings */}
      <PayloadSettingsForm payload={payload} onUpdate={onUpdate} />
    </div>
  );
}

// ─── Payload Settings Form (renders fields based on payload type) ───

function PayloadSettingsForm({
  payload,
  onUpdate,
}: {
  payload: Payload;
  onUpdate: (updates: Partial<Payload>) => void;
}) {
  const s = payload.settings;
  const set = (key: string, value: unknown) => {
    onUpdate({ settings: { ...s, [key]: value } });
  };

  switch (payload.type) {
    case "com.apple.wifi.managed":
      return (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium mb-1">SSID</label>
            <input type="text" value={(s.SSID_STR as string) || ""} onChange={(e) => set("SSID_STR", e.target.value)} className="w-full px-2 py-1.5 rounded border border-border bg-background text-sm" placeholder="Network name" />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Password</label>
            <input type="password" value={(s.password as string) || ""} onChange={(e) => set("password", e.target.value)} className="w-full px-2 py-1.5 rounded border border-border bg-background text-sm" placeholder="••••••••" />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Security</label>
            <select value={(s.securityType as string) || "WPA2 Enterprise"} onChange={(e) => set("securityType", e.target.value)} className="w-full px-2 py-1.5 rounded border border-border bg-background text-sm">
              <option>WPA/WPA2 Personal</option>
              <option>WPA2/WPA3 Personal</option>
              <option>WPA2 Enterprise</option>
              <option>WEP</option>
              <option>None</option>
            </select>
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={(s.autoJoin as boolean) ?? true} onChange={(e) => set("autoJoin", e.target.checked)} className="rounded border-border" />
              Auto-join
            </label>
          </div>
        </div>
      );

    case "com.apple.mobiledevice.passwordpolicy":
      return (
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium mb-1">Min Length</label>
            <input type="number" value={(s.minLength as number) ?? 6} onChange={(e) => set("minLength", parseInt(e.target.value) || 0)} className="w-full px-2 py-1.5 rounded border border-border bg-background text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Max Failed Attempts</label>
            <input type="number" value={(s.maxFailedAttempts as number) ?? 5} onChange={(e) => set("maxFailedAttempts", parseInt(e.target.value) || 0)} className="w-full px-2 py-1.5 rounded border border-border bg-background text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Max Auto-Lock (min)</label>
            <input type="number" value={(s.maxAutoLock as number) ?? 5} onChange={(e) => set("maxAutoLock", parseInt(e.target.value) || 0)} className="w-full px-2 py-1.5 rounded border border-border bg-background text-sm" />
          </div>
          <div className="col-span-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={(s.requireAlphanumeric as boolean) ?? false} onChange={(e) => set("requireAlphanumeric", e.target.checked)} className="rounded border-border" />
              Require alphanumeric passcode
            </label>
          </div>
        </div>
      );

    case "com.apple.application.access":
      return (
        <div className="space-y-3">
          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="mode" defaultChecked className="border-border" />
              Allow list (block everything else)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="mode" className="border-border" />
              Block list
            </label>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">App Bundle IDs (one per line)</label>
            <textarea rows={3} className="w-full px-2 py-1.5 rounded border border-border bg-background text-sm font-mono" placeholder="com.apple Safari&#10;com.company.app" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="rounded border-border" />
              Block camera
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="rounded border-border" />
              Block screenshots
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="rounded border-border" />
              Block app installation
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="rounded border-border" />
              Block Siri
            </label>
          </div>
        </div>
      );

    default:
      return (
        <div>
          <label className="block text-xs font-medium mb-1">Raw Settings (JSON)</label>
          <textarea
            rows={4}
            value={JSON.stringify(s, null, 2)}
            onChange={(e) => {
              try {
                const parsed = JSON.parse(e.target.value);
                onUpdate({ settings: parsed });
              } catch { /* invalid JSON — ignore */ }
            }}
            className="w-full px-2 py-1.5 rounded border border-border bg-background text-sm font-mono"
          />
        </div>
      );
  }
}

// ─── Default settings per payload type ───

function getDefaultSettings(type: string): Record<string, unknown> {
  switch (type) {
    case "com.apple.wifi.managed":
      return { SSID_STR: "", password: "", securityType: "WPA2 Personal", autoJoin: true, hiddenNetwork: false };
    case "com.apple.mobiledevice.passwordpolicy":
      return { minLength: 6, maxFailedAttempts: 5, maxAutoLock: 5, requireAlphanumeric: false, minComplexChars: 0 };
    case "com.apple.application.access":
      return { allowList: true, blockedApps: [], blockCamera: false, blockScreenshots: false };
    default:
      return {};
  }
}
