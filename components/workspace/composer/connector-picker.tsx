"use client";

import { useEffect, useRef, useState } from "react";

import { AppLogo } from "@/components/integrations/app-logo";
import { authFetch } from "@/lib/firebase/auth-client";

/**
 * Sélecteur de connecteurs du composer (directive Conversation-first,
 * Phase 3) : l'utilisateur active, pour CE message, les applications
 * connectées concernées. Les slugs sélectionnés accompagnent la requête —
 * le moteur conversationnel les injecte dans sa décision d'intention et
 * cible `composio.execute` sur ces toolkits (les actions sensibles restent
 * soumises à validation humaine).
 */

interface ActiveConnection {
  id: string;
  toolkit: string;
  label: string;
  category: string;
  status: string;
  enabled: boolean;
  verified: boolean;
}

interface CatalogEntry {
  toolkit: string;
  label: string;
  logo: string | null;
}

interface ConnectorPickerProps {
  selected: string[];
  onChange: (connectors: string[]) => void;
  disabled?: boolean;
}

export function ConnectorPicker({ selected, onChange, disabled = false }: ConnectorPickerProps) {
  const [open, setOpen] = useState(false);
  const [connections, setConnections] = useState<ActiveConnection[] | null>(null);
  const [logos, setLogos] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Chargement à la première ouverture (connexions actives + logos catalogue).
  useEffect(() => {
    if (!open || connections !== null) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [connectionsRes, catalogRes] = await Promise.all([
          authFetch("/api/integrations/composio/connections", { cache: "no-store" }),
          authFetch("/api/integrations/catalog", { cache: "default" }),
        ]);
        if (cancelled) return;
        if (connectionsRes.ok) {
          const data = (await connectionsRes.json()) as { connections?: ActiveConnection[] };
          setConnections(Array.isArray(data.connections) ? data.connections : []);
        } else {
          setConnections([]);
          setLoadError(true);
        }
        if (catalogRes.ok) {
          const data = (await catalogRes.json()) as { items?: CatalogEntry[] } | CatalogEntry[];
          const items = Array.isArray(data) ? data : (data.items ?? []);
          const map = new Map<string, string>();
          for (const entry of items) {
            if (entry?.toolkit && entry.logo) map.set(entry.toolkit, entry.logo);
          }
          setLogos(map);
        }
      } catch {
        if (!cancelled) {
          setConnections([]);
          setLoadError(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, connections]);

  // Fermeture au clic extérieur / Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const activeConnections = (connections ?? []).filter((connection) => connection.enabled && connection.verified);

  const toggle = (toolkit: string) => {
    if (selected.includes(toolkit)) {
      onChange(selected.filter((item) => item !== toolkit));
    } else {
      onChange([...selected, toolkit].slice(0, 8));
    }
  };

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        className={`g3-btn g3-btn-ghost !min-h-0 !px-2 !py-1.5 text-sm ${selected.length > 0 ? "!bg-neutral-900 !text-white hover:!bg-neutral-700" : ""}`}
        title="Activer des connecteurs pour ce message"
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span aria-hidden>⧉</span>
        {selected.length > 0 && (
          <span className="grid size-4 place-items-center rounded-full bg-white text-[10px] font-bold text-neutral-900" aria-hidden>
            {selected.length}
          </span>
        )}
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Connecteurs à activer pour ce message"
          className="g3-card absolute bottom-full left-0 z-50 mb-2 w-72 !p-2 shadow-xl"
        >
          <p className="px-1.5 pb-1.5 text-[11px] font-semibold text-neutral-700">
            Connecteurs pour ce message
          </p>

          {loading && (
            <p className="px-1.5 py-3 text-[11px] text-neutral-500">Chargement de vos connexions…</p>
          )}

          {!loading && activeConnections.length === 0 && (
            <div className="px-1.5 py-2 text-[11px] leading-relaxed text-neutral-500">
              {loadError ? "Connexions indisponibles pour l'instant." : "Aucune application connectée."}
              <a href="/integrations" className="ml-1 font-semibold text-neutral-900 underline underline-offset-2">
                Connecter une app
              </a>
            </div>
          )}

          {!loading && activeConnections.length > 0 && (
            <ul className="max-h-56 space-y-0.5 overflow-y-auto">
              {activeConnections.map((connection) => {
                const checked = selected.includes(connection.toolkit);
                return (
                  <li key={connection.id}>
                    <label
                      className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-[12px] transition-colors hover:bg-neutral-50 ${checked ? "bg-neutral-100" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(connection.toolkit)}
                        className="accent-neutral-900"
                        aria-label={`Activer ${connection.label}`}
                      />
                      <AppLogo
                        entry={{ toolkit: connection.toolkit, label: connection.label, logo: logos.get(connection.toolkit) ?? null }}
                        size={22}
                      />
                      <span className="min-w-0 flex-1 truncate font-medium text-neutral-800">{connection.label}</span>
                      {checked && <span aria-hidden className="text-[10px] font-bold text-neutral-900">✓</span>}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}

          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="mt-1.5 w-full rounded-lg px-1.5 py-1.5 text-left text-[11px] text-neutral-500 transition-colors hover:bg-neutral-50 hover:text-neutral-800"
            >
              Tout désélectionner ({selected.length})
            </button>
          )}

          <div className="mt-1 border-t border-neutral-100 pt-1.5">
            <a
              href="/integrations"
              className="block rounded-lg px-1.5 py-1 text-[11px] text-neutral-500 transition-colors hover:bg-neutral-50 hover:text-neutral-900"
            >
              Gérer toutes les connexions →
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
