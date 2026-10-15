import { useState, useEffect } from "react";
import {
  Smartphone,
  Plus,
  Search,
  Pencil,
  Trash2,
  Shield,
  Wifi,
  Lock,
  Globe,
  ChevronLeft,
  ChevronRight,
  MoreVertical,
  CheckCircle2,
  FileText,
  Clock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchWithAuth } from "@/stores/auth";
import { showToast } from "../shared/Toast";
import { navigateTo } from "@/lib/navigation";

// ─── Types ───

export type MdmProfileStatus = "draft" | "active" | "archived";
export type MdmTargetPlatform = "ios" | "ipados" | "macos";

export interface MdmProfile {
  id: string;
  orgId: string;
  name: string;
  description?: string;
  status: MdmProfileStatus;
  profileIdentifier: string;
  profileUuid: string;
  profileDisplayName: string;
  targetPlatforms: MdmTargetPlatform[];
  payloads: MdmPayloadSummary[];
  createdAt: string;
  updatedAt: string;
}

export interface MdmPayloadSummary {
  type: string;
  displayName: string;
}

// ─── Payload type metadata ───

const PAYLOAD_ICONS: Record<string, typeof Shield> = {
  "com.apple.wifi.managed": Wifi,
  "com.apple.mobiledevice.passwordpolicy": Lock,
  "com.apple.application.access": Shield,
  "com.apple.vpn.managed": Globe,
  "com.apple.security.scep": Lock,
  "com.apple.security.pem": Lock,
  "com.apple.webclip.managed": Globe,
  "com.apple.softwareupdate.enforcement": Clock,
  "com.apple.systempreferences": Shield,
};

function payloadIcon(type: string) {
  return PAYLOAD_ICONS[type] || FileText;
}

function payloadLabel(type: string): string {
  const labels: Record<string, string> = {
    "com.apple.wifi.managed": "Wi-Fi",
    "com.apple.mobiledevice.passwordpolicy": "Passcode",
    "com.apple.application.access": "Restrictions",
    "com.apple.vpn.managed": "VPN",
    "com.apple.security.scep": "SCEP",
    "com.apple.security.pem": "Certificate",
    "com.apple.webclip.managed": "Web Clip",
    "com.apple.softwareupdate.enforcement": "OS Update",
    "com.apple.systempreferences": "System Preferences",
    "com.apple.appstore": "App Store",
    "com.apple.managedapp.singleapp": "Single App Mode",
  };
  return labels[type] || type.split(".").pop() || type;
}

// ─── Status badge ───

function StatusBadge({ status }: { status: MdmProfileStatus }) {
  const config = {
    draft: { label: "Draft", className: "bg-muted text-muted-foreground border-border" },
    active: { label: "Active", className: "bg-success/15 text-success border-success/30" },
    archived: { label: "Archived", className: "bg-muted text-muted-foreground border-border" },
  }[status];

  return (
    <span className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border", config.className)}>
      {config.label}
    </span>
  );
}

// ─── Platform badges ───

function PlatformBadges({ platforms }: { platforms: MdmTargetPlatform[] }) {
  const labels: Record<MdmTargetPlatform, string> = {
    ios: "iOS",
    ipados: "iPadOS",
    macos: "macOS",
  };
  return (
    <div className="flex gap-1">
      {platforms.map((p) => (
        <span key={p} className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-primary/10 text-primary">
          {labels[p]}
        </span>
      ))}
    </div>
  );
}

// ─── Main component ───

export default function MdmProfileList() {
  const [profiles, setProfiles] = useState<MdmProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pageSize = 25;

  const loadProfiles = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(pageSize),
      });
      if (search) params.set("search", search);
      if (statusFilter) params.set("status", statusFilter);

      const res = await fetchWithAuth(`/api/v1/mdm/profiles?${params}`);
      if (res.ok) {
        const data = await res.json();
        setProfiles(data.profiles || []);
        setTotal(data.total || 0);
      } else {
        // API not ready yet — show empty state
        setProfiles([]);
        setTotal(0);
      }
    } catch {
      setProfiles([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProfiles();
  }, [page, statusFilter]);

  const handleDelete = async (profile: MdmProfile) => {
    if (!confirm(`Archive profile "${profile.name}"?`)) return;
    try {
      const res = await fetchWithAuth(`/api/v1/mdm/profiles/${profile.id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        showToast("Profile archived", "success");
        loadProfiles();
      } else {
        showToast("Failed to archive profile", "error");
      }
    } catch {
      showToast("Failed to archive profile", "error");
    }
  };

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Smartphone className="h-6 w-6" />
            MDM Profiles
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Apple configuration profiles for iOS, iPadOS, and macOS devices
          </p>
        </div>
        <button
          onClick={() => navigateTo("/mdm-profiles/new")}
          className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          New Profile
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search profiles..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (setPage(1), loadProfiles())}
            className="w-full pl-9 pr-3 py-2 rounded-md border border-border bg-background text-sm"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          className="px-3 py-2 rounded-md border border-border bg-background text-sm"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="draft">Draft</option>
          <option value="archived">Archived</option>
        </select>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Profile</th>
              <th className="text-left px-4 py-3 font-medium">Payloads</th>
              <th className="text-left px-4 py-3 font-medium">Platforms</th>
              <th className="text-left px-4 py-3 font-medium">Status</th>
              <th className="text-left px-4 py-3 font-medium">Updated</th>
              <th className="text-right px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">
                  Loading profiles...
                </td>
              </tr>
            ) : profiles.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <Smartphone className="h-8 w-8 text-muted-foreground" />
                    <p className="text-muted-foreground">No MDM profiles yet</p>
                    <button
                      onClick={() => navigateTo("/mdm-profiles/new")}
                      className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 mt-2"
                    >
                      <Plus className="h-4 w-4" />
                      Create your first profile
                    </button>
                  </div>
                </td>
              </tr>
            ) : (
              profiles.map((profile) => (
                <tr
                  key={profile.id}
                  className="border-t border-border hover:bg-muted/30 cursor-pointer"
                  onClick={() => navigateTo(`/mdm-profiles/${profile.id}`)}
                >
                  <td className="px-4 py-3">
                    <div className="font-medium">{profile.name}</div>
                    <div className="text-xs text-muted-foreground">{profile.profileIdentifier}</div>
                    {profile.description && (
                      <div className="text-xs text-muted-foreground mt-0.5">{profile.description}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {profile.payloads.slice(0, 3).map((p, i) => {
                        const Icon = payloadIcon(p.type);
                        return (
                          <span
                            key={i}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-secondary text-secondary-foreground"
                            title={p.type}
                          >
                            <Icon className="h-3 w-3" />
                            {payloadLabel(p.type)}
                          </span>
                        );
                      })}
                      {profile.payloads.length > 3 && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-muted text-muted-foreground">
                          +{profile.payloads.length - 3}
                        </span>
                      )}
                      {profile.payloads.length === 0 && (
                        <span className="text-xs text-muted-foreground">No payloads</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <PlatformBadges platforms={profile.targetPlatforms} />
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={profile.status} />
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {new Date(profile.updatedAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => navigateTo(`/mdm-profiles/${profile.id}`)}
                        className="p-1.5 rounded hover:bg-muted"
                        title="Edit"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(profile)}
                        className="p-1.5 rounded hover:bg-destructive/10 text-destructive"
                        title="Archive"
                        disabled={profile.status === "archived"}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {total} profile{total !== 1 ? "s" : ""}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="p-1.5 rounded border border-border disabled:opacity-50"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm">{page} / {totalPages}</span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="p-1.5 rounded border border-border disabled:opacity-50"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
