import { useState, useEffect } from "react";
import {
  Key,
  Building2,
  Upload,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Shield,
  Calendar,
  Smartphone,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchWithAuth } from "@/stores/auth";
import { showToast } from "../shared/Toast";

interface ApnsConfig {
  configured: boolean;
  certExpiry?: string;
  daysUntilExpiry?: number;
  needsRenewal: boolean;
  abmEnabled: boolean;
  abmLastSync?: string;
  scepEnabled: boolean;
}

export default function MdmSettings() {
  const [config, setConfig] = useState<ApnsConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // Certificate upload form
  const [certFile, setCertFile] = useState<File | null>(null);
  const [keyFile, setKeyFile] = useState<File | null>(null);
  const [topic, setTopic] = useState("");

  const loadConfig = async () => {
    setLoading(true);
    try {
      const res = await fetchWithAuth("/api/v1/mdm/settings/apns");
      if (res.ok) {
        setConfig(await res.json());
      }
    } catch {
      // API not ready
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadConfig();
  }, []);

  const handleUploadCert = async () => {
    if (!certFile) {
      showToast("Select a certificate file", "error");
      return;
    }

    setUploading(true);
    try {
      // Read cert file as text (PEM format)
      const certPem = await certFile.text();
      const keyPem = keyFile ? await keyFile.text() : "";

      const res = await fetchWithAuth("/api/v1/mdm/settings/apns", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cert_pem: certPem,
          key_pem: keyPem,
          topic: topic || undefined,
        }),
      });

      if (res.ok) {
        showToast("APNs certificate uploaded", "success");
        setCertFile(null);
        setKeyFile(null);
        loadConfig();
      } else {
        showToast("Failed to upload certificate", "error");
      }
    } catch {
      showToast("Failed to upload certificate", "error");
    } finally {
      setUploading(false);
    }
  };

  const handleAbmSync = async () => {
    setSyncing(true);
    try {
      const res = await fetchWithAuth("/api/v1/mdm/settings/abm/sync", {
        method: "POST",
      });
      if (res.ok) {
        showToast("ABM sync started", "success");
        loadConfig();
      } else {
        showToast("Failed to start ABM sync", "error");
      }
    } catch {
      showToast("Failed to start ABM sync", "error");
    } finally {
      setSyncing(false);
    }
  };

  if (loading) {
    return <div className="p-8 text-center text-muted-foreground">Loading settings...</div>;
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Smartphone className="h-6 w-6" />
          MDM Settings
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Apple Push Notification and Business Manager configuration
        </p>
      </div>

      {/* APNs Certificate */}
      <div className="rounded-lg border border-border p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Key className="h-5 w-5 text-primary" />
          <h2 className="font-medium">APNs Push Certificate</h2>
        </div>

        {config?.configured ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-success" />
              <span className="text-sm">Certificate configured</span>
            </div>
            {config.certExpiry && (
              <div className="flex items-center gap-2 text-sm">
                <Calendar className="h-4 w-4 text-muted-foreground" />
                <span>
                  Expires {new Date(config.certExpiry).toLocaleDateString()}
                  {config.daysUntilExpiry !== undefined && (
                    <span className={cn("ml-1", config.needsRenewal ? "text-destructive font-medium" : "text-muted-foreground")}>
                      ({config.daysUntilExpiry} days)
                    </span>
                  )}
                </span>
              </div>
            )}
            {config.needsRenewal && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-warning/10 border border-warning/30 text-sm">
                <AlertTriangle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">Certificate expiring soon</p>
                  <p className="text-muted-foreground">
                    Renew your APNs certificate at{" "}
                    <a href="https://identity.apple.com" target="_blank" rel="noopener noreferrer" className="text-primary underline">
                      Apple Push Certificates Portal
                    </a>{" "}
                    and upload the new one below.
                  </p>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/50 border border-border text-sm">
            <AlertTriangle className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">No APNs certificate configured</p>
              <p className="text-muted-foreground">
                Upload your APNs push certificate to enable MDM commands. Get one free from the{" "}
                <a href="https://identity.apple.com" target="_blank" rel="noopener noreferrer" className="text-primary underline">
                  Apple Push Certificates Portal
                </a>.
              </p>
            </div>
          </div>
        )}

        {/* Upload form */}
        <div className="space-y-3 pt-2 border-t border-border">
          <h3 className="text-sm font-medium">{config?.configured ? "Replace Certificate" : "Upload Certificate"}</h3>

          <div>
            <label className="block text-xs font-medium mb-1">Certificate (.pem or .p12)</label>
            <input
              type="file"
              accept=".pem,.p12,.cer,.crt"
              onChange={(e) => setCertFile(e.target.files?.[0] || null)}
              className="w-full text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Private Key (.pem) — optional if included in cert</label>
            <input
              type="file"
              accept=".pem,.key"
              onChange={(e) => setKeyFile(e.target.files?.[0] || null)}
              className="w-full text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">APNs Topic (Bundle ID)</label>
            <input
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="com.yourcompany.mdm"
              className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm font-mono"
            />
          </div>

          <button
            onClick={handleUploadCert}
            disabled={uploading || !certFile}
            className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
          >
            <Upload className="h-4 w-4" />
            {uploading ? "Uploading..." : "Upload Certificate"}
          </button>
        </div>
      </div>

      {/* Apple Business Manager */}
      <div className="rounded-lg border border-border p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Building2 className="h-5 w-5 text-primary" />
          <h2 className="font-medium">Apple Business Manager</h2>
        </div>

        <p className="text-sm text-muted-foreground">
          Link Apple Business Manager for zero-touch device enrollment (ADE).
          Devices purchased through ABM will automatically enroll in Breeze MDM on first boot.
        </p>

        {config?.abmEnabled ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-success" />
              <span className="text-sm">ABM linked</span>
            </div>
            {config.abmLastSync && (
              <p className="text-sm text-muted-foreground">
                Last sync: {new Date(config.abmLastSync).toLocaleString()}
              </p>
            )}
            <button
              onClick={handleAbmSync}
              disabled={syncing}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-border text-sm hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw className={cn("h-4 w-4", syncing && "animate-spin")} />
              {syncing ? "Syncing..." : "Sync Now"}
            </button>
          </div>
        ) : (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/50 border border-border text-sm">
            <Shield className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">ABM not linked</p>
              <p className="text-muted-foreground">
                ABM integration is coming in Phase 5. For now, use manual enrollment
                (download the .mobileconfig profile and install it on each device).
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Enrollment info */}
      <div className="rounded-lg border border-border p-6 space-y-4">
        <h2 className="font-medium">Manual Enrollment</h2>
        <p className="text-sm text-muted-foreground">
          To enroll a device manually, generate an enrollment link or QR code from the{" "}
          <a href="/mdm-profiles" className="text-primary underline">MDM Profiles</a> page,
          then open it on the Apple device.
        </p>
        <a
          href="/mdm-profiles"
          className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90"
        >
          <Smartphone className="h-4 w-4" />
          Go to MDM Profiles
        </a>
      </div>
    </div>
  );
}
