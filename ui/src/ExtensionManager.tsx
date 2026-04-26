import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button, Badge } from "@radix-ui/themes";
import { Download, CheckCircle, HardDrive, Cpu, Cloud, BarChart2, FileOutput, Bot } from "lucide-react";
import { useTheme } from "./ThemeContext";

interface Extension {
  id: string;
  name: string;
  description: string;
  size_mb: number;
  is_installed: boolean;
  category: string;
  min_version: string;
}

const CATEGORY_META: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  local_llm:              { label: "Local LLM",              icon: <Bot size={14} />,        color: "#a78bfa" },
  hardware_acceleration:  { label: "Hardware Acceleration",  icon: <Cpu size={14} />,        color: "#60a5fa" },
  cloud_bridge:           { label: "Cloud Bridge",           icon: <Cloud size={14} />,      color: "#38bdf8" },
  analysis_plugin:        { label: "Analysis Plugins",       icon: <BarChart2 size={14} />,  color: "#4ade80" },
  export_plugin:          { label: "Export Plugins",         icon: <FileOutput size={14} />, color: "#fb923c" },
};

export function ExtensionManager() {
  const theme = useTheme();
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [loading, setLoading]       = useState(true);
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const [progress, setProgress]     = useState<Record<string, number>>({});

  useEffect(() => {
    invoke<Extension[]>("get_extensions")
      .then(setExtensions)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const handleInstall = (id: string) => {
    setInstalling((prev) => new Set(prev).add(id));
    setProgress((prev) => ({ ...prev, [id]: 0 }));

    // Simulate progressive download
    const interval = setInterval(() => {
      setProgress((prev) => {
        const current = prev[id] ?? 0;
        if (current >= 100) {
          clearInterval(interval);
          setInstalling((s) => { const n = new Set(s); n.delete(id); return n; });
          setExtensions((exts) =>
            exts.map((e) => (e.id === id ? { ...e, is_installed: true } : e))
          );
          return prev;
        }
        // Round-5 T-3: fixed 20% tick (Yuan OSDI 2014 deterministic
        // fixture).  No RNG — the extension store is not actually
        // downloading anything; the bar just mirrors install state.
        return { ...prev, [id]: Math.min(100, current + 20) };
      });
    }, 120);
  };

  if (loading) {
    return (
      <div className="w-full h-full flex items-center justify-center" style={{ background: theme.bg }}>
        <div style={{ color: theme.textMuted, fontSize: 13 }} className="animate-pulse">Loading extensions…</div>
      </div>
    );
  }

  // Group by category
  const grouped = extensions.reduce<Record<string, Extension[]>>((acc, ext) => {
    (acc[ext.category] = acc[ext.category] ?? []).push(ext);
    return acc;
  }, {});

  const installedCount = extensions.filter((e) => e.is_installed).length;

  return (
    <div className="w-full h-full overflow-y-auto" style={{ background: theme.bgPanel }}>
      <div className="max-w-3xl mx-auto px-8 py-6 flex flex-col gap-8">

        {/* Header */}
        <div>
          <div className="flex items-center gap-3 mb-1">
            <HardDrive size={22} style={{ color: theme.accent }} />
            <h2 className="text-xl font-bold" style={{ color: theme.text }}>AI Extension Store</h2>
            <Badge style={{ background: theme.accentBg, color: theme.accent }} variant="soft" size="1" className="ml-auto">
              {installedCount}/{extensions.length} installed
            </Badge>
          </div>
          <p style={{ color: theme.textMuted, fontSize: 13, marginTop: 4 }}>
            Manage local LLMs, hardware backends, cloud bridges, and analysis plugins.
          </p>
        </div>

        {/* Category Sections */}
        {Object.entries(CATEGORY_META).map(([cat, meta]) => {
          const items = grouped[cat];
          if (!items || items.length === 0) return null;

          return (
            <section key={cat}>
              <div className="flex items-center gap-2 mb-3 text-sm font-semibold" style={{ color: meta.color }}>
                {meta.icon}
                {meta.label}
              </div>

              <div className="flex flex-col gap-3">
                {items.map((ext) => {
                  const isInstalling = installing.has(ext.id);
                  const pct = progress[ext.id] ?? 0;

                  return (
                    <div
                      key={ext.id}
                      style={{ background: theme.bgSurface, border: `0.5px solid ${theme.borderSubtle}`, borderRadius: 8, padding: 16 }}
                      className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between transition-colors"
                      onMouseEnter={e => e.currentTarget.style.borderColor = theme.borderDim}
                      onMouseLeave={e => e.currentTarget.style.borderColor = theme.border}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                          <h3 className="text-sm font-semibold" style={{ color: theme.textDim }}>{ext.name}</h3>
                          {ext.is_installed && (
                            <Badge color="green" variant="soft" size="1">Installed</Badge>
                          )}
                          <span className="text-[10px] font-mono ml-auto sm:ml-0" style={{ color: theme.textFaint }}>
                            req. {ext.min_version}
                          </span>
                        </div>
                        <p className="text-xs leading-relaxed" style={{ color: theme.textMuted, marginTop: 4 }}>{ext.description}</p>

                        {/* Progress bar */}
                        {isInstalling && (
                          <div className="mt-2">
                            <div className="w-full h-1 rounded-full overflow-hidden" style={{ background: theme.bgInput }}>
                              <div
                                className="h-full transition-all duration-150 rounded-full"
                                style={{ width: `${pct.toFixed(0)}%`, background: theme.accent }}
                              />
                            </div>
                            <div className="text-[10px] mt-0.5" style={{ color: theme.accent }}>
                              Downloading… {pct.toFixed(0)}%
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-3 shrink-0">
                        <span className="text-[10px] font-mono" style={{ color: theme.textFaint }}>{ext.size_mb} MB</span>
                        {ext.is_installed ? (
                          <Button variant="soft" color="gray" size="1" disabled>
                            <CheckCircle size={13} /> Installed
                          </Button>
                        ) : isInstalling ? (
                          <Button variant="soft" color="blue" size="1" disabled>
                            Installing…
                          </Button>
                        ) : (
                          <Button
                            variant="solid"
                            color="blue"
                            size="1"
                            onClick={() => handleInstall(ext.id)}
                            style={{ background: theme.accent }}
                          >
                            <Download size={13} /> Download
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
