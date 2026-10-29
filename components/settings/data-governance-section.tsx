"use client";

import { useCallback, useState } from "react";

import { authFetch } from "@/lib/firebase/auth-client";

/**
 * Section « Mes données » des Paramètres — gouvernance des données
 * (Job 478451, it. 25).
 *
 * Constat d'audit : les endpoints RGPD existaient (/api/memory/export,
 * /api/memory/purge) mais AUCUNE surface utilisateur ne les exposait —
 * des droits fondamentaux techniquement présents, concrètement morts.
 * Cette section les rend accessibles et ajoute l'export COMPLET du compte
 * (/api/account/export : mémoire + conversations + agents).
 *
 * it. 29 : l'export des PARAMÈTRES (/api/settings/export-data — préférences,
 * artefacts, jobs, manifeste honnête {count, tronque}) était livré depuis
 * l'it. 27 sans aucune surface utilisateur — la garde anti-code-mort
 * (tests/unit/api-endpoints-dead-code-guard.test.ts) l'a signalé, cette
 * section le câble et la baseline se rétrécit d'autant.
 *
 * Effacement : double consentement applicatif — la première action arme la
 * confirmation, la seconde envoie `{ confirm: true }` (le serveur répond
 * 428 sans lui). Un seul clic ne peut jamais effacer quoi que ce soit.
 *
 * Palette : tokens existants UNIQUEMENT (g3-*) — aucune nouvelle couleur.
 */

type ActionKey = "export-compte" | "export-memoire" | "export-parametres" | "purge-memoire";

function horodate(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

async function telecharge(authed: boolean, url: string, nomFichier: string): Promise<void> {
  const response = authed ? await authFetch(url, { cache: "no-store" }) : await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Export impossible (${response.status}).`);
  }
  const blob = await response.blob();
  const lien = document.createElement("a");
  lien.href = URL.createObjectURL(blob);
  lien.download = nomFichier;
  document.body.appendChild(lien);
  lien.click();
  URL.revokeObjectURL(lien.href);
  lien.remove();
}

export function DataGovernanceSection() {
  const [enCours, setEnCours] = useState<ActionKey | null>(null);
  const [message, setMessage] = useState<{ ton: "ok" | "erreur"; texte: string } | null>(null);
  const [purgeArmee, setPurgeArmee] = useState(false);

  const exportCompte = useCallback(async () => {
    setEnCours("export-compte");
    setMessage(null);
    try {
      await telecharge(true, "/api/account/export", `gen3ia-compte-${horodate()}.json`);
      setMessage({ ton: "ok", texte: "Export complet du compte téléchargé (mémoire, conversations, agents)." });
    } catch (cause) {
      setMessage({ ton: "erreur", texte: cause instanceof Error ? cause.message : "Export impossible." });
    } finally {
      setEnCours(null);
    }
  }, []);

  const exportMemoire = useCallback(async () => {
    setEnCours("export-memoire");
    setMessage(null);
    try {
      await telecharge(true, "/api/memory/export", `gen3ia-memoire-${horodate()}.json`);
      setMessage({ ton: "ok", texte: "Export de la mémoire personnalisée téléchargé." });
    } catch (cause) {
      setMessage({ ton: "erreur", texte: cause instanceof Error ? cause.message : "Export impossible." });
    } finally {
      setEnCours(null);
    }
  }, []);

  const exportParametres = useCallback(async () => {
    setEnCours("export-parametres");
    setMessage(null);
    try {
      await telecharge(true, "/api/settings/export-data", `gen3ia-parametres-${horodate()}.json`);
      setMessage({ ton: "ok", texte: "Export des paramètres téléchargé (préférences, artefacts, jobs — manifeste inclus)." });
    } catch (cause) {
      setMessage({ ton: "erreur", texte: cause instanceof Error ? cause.message : "Export impossible." });
    } finally {
      setEnCours(null);
    }
  }, []);

  const purgeMemoire = useCallback(async () => {
    if (!purgeArmee) {
      setPurgeArmee(true);
      setMessage({
        ton: "ok",
        texte: "Action armée : cliquez à nouveau sur « Confirmer l'effacement » pour effacer irréversiblement.",
      });
      return;
    }
    setEnCours("purge-memoire");
    setMessage(null);
    try {
      const response = await authFetch("/api/memory/purge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!response.ok) throw new Error(body.error || "Purge impossible.");
      setPurgeArmee(false);
      setMessage({ ton: "ok", texte: "Mémoire personnalisée effacée : souvenirs, retours IA, leçons et consentements." });
    } catch (cause) {
      setMessage({ ton: "erreur", texte: cause instanceof Error ? cause.message : "Purge impossible." });
    } finally {
      setEnCours(null);
    }
  }, [purgeArmee]);

  const occuppe = enCours !== null;

  return (
    <section className="g3-gradient-border mt-6 p-6" aria-labelledby="settings-data-title">
      <h2 id="settings-data-title" className="font-[family-name:var(--font-display)] text-2xl font-semibold">
        Mes données
      </h2>
      <p className="mt-2 text-sm leading-6 text-[var(--g3-muted)]">
        Vos données vous appartiennent. Téléchargez-les à tout moment dans un format
        lisible et portable, ou effacez la mémoire personnalisée que Gen3ia retient
        sur votre compte — sans toucher à vos conversations ni à vos agents.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={exportCompte}
          disabled={occuppe}
          className="inline-flex items-center gap-2 rounded-full border border-[var(--g3-primary-border)] bg-[var(--g3-primary-soft)] px-4 py-2.5 text-sm font-semibold text-[var(--g3-text)] transition hover:border-[var(--g3-primary)] hover:shadow-[0_10px_30px_-14px_var(--g3-primary)] disabled:opacity-50"
        >
          {enCours === "export-compte" ? "Préparation…" : "Exporter tout le compte (JSON)"}
        </button>
        <button
          type="button"
          onClick={exportMemoire}
          disabled={occuppe}
          className="inline-flex items-center gap-2 rounded-full border border-[var(--g3-border)] px-4 py-2.5 text-sm font-semibold text-[var(--g3-text)] transition hover:border-[var(--g3-primary)] disabled:opacity-50"
        >
          {enCours === "export-memoire" ? "Préparation…" : "Exporter la mémoire seule"}
        </button>
        <button
          type="button"
          onClick={exportParametres}
          disabled={occuppe}
          className="inline-flex items-center gap-2 rounded-full border border-[var(--g3-border)] px-4 py-2.5 text-sm font-semibold text-[var(--g3-text)] transition hover:border-[var(--g3-primary)] disabled:opacity-50"
        >
          {enCours === "export-parametres" ? "Préparation…" : "Exporter les paramètres"}
        </button>
      </div>

      <div className="mt-6 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-4">
        <h3 className="text-sm font-semibold text-[var(--g3-text)]">Effacer la mémoire personnalisée</h3>
        <p className="mt-1 text-xs leading-5 text-[var(--g3-muted)]">
          Supprime de façon irréversible les souvenirs, retours IA, leçons et
          consentements associés à votre compte. Double confirmation demandée.
        </p>
        <button
          type="button"
          onClick={purgeMemoire}
          disabled={occuppe}
          className={
            purgeArmee
              ? "mt-3 inline-flex items-center gap-2 rounded-full bg-[var(--g3-primary)] px-4 py-2.5 text-sm font-bold text-white transition disabled:opacity-50"
              : "mt-3 inline-flex items-center gap-2 rounded-full border border-[var(--g3-border)] px-4 py-2.5 text-sm font-semibold text-[var(--g3-text)] transition hover:border-[var(--g3-primary)] disabled:opacity-50"
          }
        >
          {enCours === "purge-memoire" ? "Effacement…" : purgeArmee ? "Confirmer l'effacement" : "Effacer la mémoire"}
        </button>
      </div>

      <p
        role="status"
        className={
          message
            ? message.ton === "ok"
              ? "mt-3 text-xs font-semibold leading-5 text-[var(--g3-success-strong, var(--g3-text))]"
              : "mt-3 text-xs font-semibold leading-5 text-[var(--g3-danger-strong, var(--g3-text))]"
            : "mt-3 text-xs leading-5 text-[var(--g3-faint)]"
        }
      >
        {message ? message.texte : "Les exports se téléchargent en fichier JSON horodaté."}
      </p>
    </section>
  );
}
