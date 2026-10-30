"use client";

import { useCallback, useState } from "react";

import { useDeveloper } from "@/components/developer/developer-context";

/**
 * Secrets d'extension — câblage de l'API /api/developer/secrets (it.43).
 *
 * Les valeurs sont stockées SERVEUR uniquement : l'API ne les retourne
 * JAMAIS (ni en clair, ni chiffrées). L'UI n'affiche donc que l'état
 * « configuré / à définir » de chaque ref déclarée dans le manifest de
 * l'extension, avec un champ de saisie vierge pour (re)définir la valeur.
 * Injection dans les requêtes sortantes assurée par le runtime d'exécution.
 */

type SecretRef = { ref: string; description?: string; configured: boolean };

export function ExtensionSecrets({ extensionId }: { extensionId: string }) {
  const { api, busy, setBusy, setMessage } = useDeveloper();
  const [refs, setRefs] = useState<SecretRef[] | null>(null);
  const [chargement, setChargement] = useState(false);
  const [valeurs, setValeurs] = useState<Record<string, string>>({});
  const [erreur, setErreur] = useState("");

  const charger = useCallback(async () => {
    setChargement(true);
    setErreur("");
    try {
      const response = await api(`/api/developer/secrets?extensionId=${encodeURIComponent(extensionId)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setRefs(data.secrets ?? []);
    } catch (error) {
      setErreur(error instanceof Error ? error.message : "Chargement des secrets impossible");
      setRefs([]);
    } finally {
      setChargement(false);
    }
  }, [api, extensionId]);

  const definir = async (ref: string) => {
    const value = (valeurs[ref] ?? "").trim();
    if (!value) {
      setMessage("Saisis une valeur avant d'enregistrer.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const response = await api("/api/developer/secrets", {
        method: "PUT",
        body: JSON.stringify({ extensionId, ref, value }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setValeurs((courantes) => ({ ...courantes, [ref]: "" }));
      setMessage(`Secret « ${ref} » enregistré (serveur uniquement).`);
      await charger();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Enregistrement impossible");
    } finally {
      setBusy(false);
    }
  };

  const retirer = async (ref: string) => {
    if (!confirm(`Retirer le secret « ${ref} » ? Les exécutions de l'extension en dépendent peut-être.`)) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await api("/api/developer/secrets", {
        method: "DELETE",
        body: JSON.stringify({ extensionId, ref }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setMessage(`Secret « ${ref} » retiré.`);
      await charger();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Suppression impossible");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded-xl border bg-[var(--g3-elevated)] p-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold">
          Secrets de l&apos;extension — stockage serveur uniquement, jamais retournés
        </div>
        <button type="button" onClick={() => void charger()} disabled={chargement} className="text-xs underline disabled:opacity-40">
          {chargement ? "Chargement…" : refs === null ? "Charger les refs" : "Rafraîchir"}
        </button>
      </div>
      {erreur && <div className="mt-2 text-xs text-[var(--g3-danger-strong)]">{erreur}</div>}
      {refs !== null && refs.length === 0 && (
        <div className="mt-2 text-xs text-[var(--g3-muted)]">
          Aucune ref déclarée dans le manifest de cette version.
        </div>
      )}
      {refs !== null && refs.length > 0 && (
        <ul className="mt-2 space-y-3">
          {refs.map((item) => (
            <li key={item.ref} className="text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <code className="font-mono">{item.ref}</code>
                <span className={item.configured ? "text-[var(--g3-success-strong)]" : "text-[var(--g3-muted)]"}>
                  {item.configured ? "configuré" : "à définir"}
                </span>
                {item.configured && (
                  <button type="button" onClick={() => void retirer(item.ref)} disabled={busy} className="text-[var(--g3-danger-strong)] underline disabled:opacity-40">
                    Retirer
                  </button>
                )}
              </div>
              {item.description && <div className="mt-1 text-[var(--g3-muted)]">{item.description}</div>}
              <div className="mt-1 flex gap-2">
                <input
                  type="password"
                  autoComplete="off"
                  value={valeurs[item.ref] ?? ""}
                  onChange={(event) => setValeurs((courantes) => ({ ...courantes, [item.ref]: event.target.value }))}
                  placeholder="Valeur (jamais réaffichée)"
                  className="flex-1 rounded-lg border p-2 font-mono text-xs"
                />
                <button type="button" onClick={() => void definir(item.ref)} disabled={busy} className="rounded-lg bg-black px-3 py-2 font-semibold text-white disabled:opacity-40">
                  Enregistrer
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
