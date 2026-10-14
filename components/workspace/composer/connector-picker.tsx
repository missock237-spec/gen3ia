"use client";

import { useEffect, useRef, useState } from "react";

import { AppLogo } from "@/components/integrations/app-logo";
import { authFetch, readJsonSafely } from "@/lib/firebase/auth-client";

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

/** API personnelle déclarée par l'utilisateur (appel réel via custom_api.*). */
interface PersonalApi {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
}

/** Services populaires proposés à la connexion directe depuis le chat
 * (Task 143 — axe 1) : l'agent doit pouvoir amener l'utilisateur à autoriser
 * un service en un clic, sans quitter la conversation. */
const SUGGESTED_TOOLKITS = [
  "gmail",
  "googledrive",
  "googlecalendar",
  "slack",
  "notion",
  "github",
  "whatsapp",
  "telegram",
] as const;

interface ConnectorPickerProps {
  selected: string[];
  onChange: (connectors: string[]) => void;
  disabled?: boolean;
}

export function ConnectorPicker({ selected, onChange, disabled = false }: ConnectorPickerProps) {
  const [open, setOpen] = useState(false);
  const [connections, setConnections] = useState<ActiveConnection[] | null>(null);
  const [personalApis, setPersonalApis] = useState<PersonalApi[]>([]);
  const [logos, setLogos] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Chargement à la première ouverture (connexions actives + API personnelles + logos).
  useEffect(() => {
    if (!open || connections !== null) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [connectionsRes, catalogRes, apisRes] = await Promise.all([
          authFetch("/api/integrations/composio/connections", { cache: "no-store" }),
          authFetch("/api/integrations/catalog", { cache: "default" }),
          authFetch("/api/custom-apis", { cache: "no-store" }),
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
        if (apisRes.ok) {
          const data = (await apisRes.json()) as { apis?: PersonalApi[] };
          setPersonalApis(Array.isArray(data.apis) ? data.apis.filter((api) => api.enabled) : []);
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

  /** Services populaires NON encore connectés (max 4) — bouton de connexion
   * OAuth direct dans le panneau, même logique que la carte du fil. */
  const connectSuggestions = activeConnections.length
    ? []
    : SUGGESTED_TOOLKITS.filter((toolkit) => !activeConnections.some((c) => c.toolkit === toolkit)).slice(0, 4);

  const [connecting, setConnecting] = useState<string | null>(null);

  /** Lance la connexion OAuth d'un service depuis le picker (redirection). */
  const connectService = async (toolkit: string) => {
    if (connecting) return;
    setConnecting(toolkit);
    try {
      const response = await authFetch("/api/integrations/composio/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolkit }),
      });
      const body = await readJsonSafely<{ authorizationUrl?: string }>(response);
      if (response.ok && body?.authorizationUrl) {
        window.location.assign(body.authorizationUrl);
        return;
      }
    } catch {
      /* redirection impossible : on reste sur place */
    }
    setConnecting(null);
  };

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
        className={`g3-btn g3-btn-ghost !min-h-0 !px-2 !py-1.5 text-sm ${selected.length > 0 ? "!bg-[var(--g3-deep)] !text-white hover:!bg-[var(--g3-elevated)]" : ""}`}
        title="Activer des connecteurs pour ce message"
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span aria-hidden>⧉</span>
        {selected.length > 0 && (
          <span className="grid size-4 place-items-center rounded-full bg-[var(--g3-surface)] text-[10px] font-bold text-[var(--g3-text)]" aria-hidden>
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
          <p className="px-1.5 pb-1.5 text-[11px] font-semibold text-[var(--g3-text-secondary)]">
            Connecteurs pour ce message
          </p>

          {loading && (
            <p className="px-1.5 py-3 text-[11px] text-[var(--g3-muted)]">Chargement de vos connexions…</p>
          )}

          {!loading && activeConnections.length === 0 && (
            <div className="px-1.5 py-2 text-[11px] leading-relaxed text-[var(--g3-muted)]">
              {loadError ? "Connexions indisponibles pour l'instant." : "Aucune application connectée."}
              {connectSuggestions.length > 0 && (
                <div className="mt-2 space-y-1">
                  <p className="font-semibold text-[var(--g3-text-secondary)]">Services populaires :</p>
                  <div className="flex flex-wrap gap-1.5">
                    {connectSuggestions.map((toolkit) => (
                      <button
                        key={toolkit}
                        type="button"
                        onClick={() => void connectService(toolkit)}
                        disabled={connecting !== null}
                        className="g3-chip !text-[10px] font-semibold"
                        title={`Connecter ${toolkit} — redirection vers la page d'autorisation`}
                      >
                        {connecting === toolkit ? "…" : `+ ${toolkit}`}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <a href="/integrations" className="ml-1 font-semibold text-[var(--g3-text)] underline underline-offset-2">
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
                      className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-[12px] transition-colors hover:bg-[var(--g3-elevated)] ${checked ? "bg-[var(--g3-elevated)]" : ""}`}
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
                      <span className="min-w-0 flex-1 truncate font-medium text-[var(--g3-text)]">{connection.label}</span>
                      {checked && <span aria-hidden className="text-[10px] font-bold text-[var(--g3-text)]">✓</span>}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}

          {!loading && personalApis.length > 0 && (
            <>
              <p className="mt-2 border-t border-[var(--g3-border)] px-1.5 pb-1 pt-2 text-[11px] font-semibold text-[var(--g3-text-secondary)]">
                Mes API personnelles (appels réels)
              </p>
              <ul className="max-h-40 space-y-0.5 overflow-y-auto">
                {personalApis.map((api) => {
                  const slug = `api-${api.id}`;
                  const checked = selected.includes(slug);
                  return (
                    <li key={api.id}>
                      <label
                        className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-[12px] transition-colors hover:bg-[var(--g3-elevated)] ${checked ? "bg-[var(--g3-elevated)]" : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggle(slug)}
                          className="accent-neutral-900"
                          aria-label={`Activer l'API ${api.name}`}
                        />
                        <span aria-hidden className="grid size-[22px] shrink-0 place-items-center rounded-md bg-[var(--g3-deep)] text-[10px] font-bold text-white">
                          API
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-[var(--g3-text)]">{api.name}</span>
                          <span className="block truncate text-[10px] text-[var(--g3-muted)]">{api.baseUrl}</span>
                        </span>
                        {checked && <span aria-hidden className="text-[10px] font-bold text-[var(--g3-text)]">✓</span>}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="mt-1.5 w-full rounded-lg px-1.5 py-1.5 text-left text-[11px] text-[var(--g3-muted)] transition-colors hover:bg-[var(--g3-elevated)] hover:text-[var(--g3-text)]"
            >
              Tout désélectionner ({selected.length})
            </button>
          )}

          <div className="mt-1 border-t border-[var(--g3-border)] pt-1.5">
            <a
              href="/integrations"
              className="block rounded-lg px-1.5 py-1 text-[11px] text-[var(--g3-muted)] transition-colors hover:bg-[var(--g3-elevated)] hover:text-[var(--g3-text)]"
            >
              Gérer toutes les connexions →
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
