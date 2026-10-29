"use client";

import { useCallback, useEffect, useState } from "react";

import { authFetch } from "@/lib/firebase/auth-client";

/**
 * Section « Consentements » des Paramètres — panneau de transparence
 * (Job 478451, it. 30).
 *
 * Constat d'audit (garde anti-code-mort it. 29) : deux endpoints de
 * consentement existaient, testés et déployés, sans AUCUNE surface
 * utilisateur — l'utilisateur ne pouvait ni voir ni modifier :
 *  - /api/memory/consent  — droit de retrait du traitement mémoire
 *    (retrait immédiat ; les données existantes ne sont PAS supprimées,
 *    la purge est une action séparée de la section « Mes données ») ;
 *  - /api/settings/tool-consents — consentement par catégorie d'outils
 *    (ask | always | deny).
 *
 * Honnêteté copiée du serveur : le mode « always » ne pré-approuve JAMAIS
 * les écritures/externes — la validation humaine existante reste la couche
 * finale (lib/security/tool-consents.ts, decideConsent) ; cette limite est
 * affichée telle quelle dans l'interface.
 *
 * Accessibilité : éléments natifs (checkbox, fieldset/legend, radio) —
 * navigables au clavier sans widget artificiel. Palette : tokens g3-*
 * existants UNIQUEMENT.
 */

type Category = { id: string; label: string };
type Mode = "ask" | "always" | "deny";

const LIBELLES_MODES: Record<Mode, string> = {
  ask: "Demander à chaque fois",
  always: "Toujours autoriser",
  deny: "Refuser",
};

const DESCRIPTIONS_MODES: Record<Mode, string> = {
  ask: "Gen3ia demande votre accord avant chaque utilisation.",
  always: "Sans redemander — mais jamais pour les écritures et actions sensibles : la validation humaine reste la couche finale.",
  deny: "La catégorie d'outils n'est jamais utilisée.",
};

export function ConsentsSection() {
  const [memoire, setMemoire] = useState<boolean | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [modes, setModes] = useState<Record<string, Mode>>({});
  const [enCours, setEnCours] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ton: "ok" | "erreur"; texte: string } | null>(null);

  useEffect(() => {
    let vivant = true;
    (async () => {
      try {
        const [reponseMemoire, reponseOutils] = await Promise.all([
          authFetch("/api/memory/consent", { cache: "no-store" }),
          authFetch("/api/settings/tool-consents", { cache: "no-store" }),
        ]);
        if (!reponseMemoire.ok || !reponseOutils.ok) throw new Error("Lecture des consentements impossible.");
        const corpsMemoire = (await reponseMemoire.json()) as { memoryProcessing?: boolean };
        const corpsOutils = (await reponseOutils.json()) as {
          consents?: Record<string, Mode>;
          categories?: Category[];
        };
        if (!vivant) return;
        setMemoire(Boolean(corpsMemoire.memoryProcessing));
        setCategories(corpsOutils.categories ?? []);
        setModes(corpsOutils.consents ?? {});
      } catch (cause) {
        if (!vivant) return;
        setMemoire(false);
        setMessage({
          ton: "erreur",
          texte: cause instanceof Error ? cause.message : "Lecture des consentements impossible.",
        });
      }
    })();
    return () => {
      vivant = false;
    };
  }, []);

  const changeMemoire = useCallback(
    async (suivant: boolean) => {
      const precedent = memoire;
      setMemoire(suivant);
      setEnCours("memoire");
      setMessage(null);
      try {
        const reponse = await authFetch("/api/memory/consent", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ memoryProcessing: suivant }),
        });
        const corps = (await reponse.json().catch(() => ({}))) as { memoryProcessing?: boolean; error?: string };
        if (!reponse.ok) throw new Error(corps.error || "Mise à jour impossible.");
        setMemoire(Boolean(corps.memoryProcessing));
        setMessage({
          ton: "ok",
          texte: suivant
            ? "Traitement mémoire autorisé : Gen3ia peut enrichir vos conversations de vos souvenirs."
            : "Retrait immédiat : Gen3ia n'exploite plus votre mémoire personnalisée (les données existantes ne sont pas supprimées — voir « Mes données »).",
        });
      } catch (cause) {
        setMemoire(precedent);
        setMessage({
          ton: "erreur",
          texte: cause instanceof Error ? cause.message : "Mise à jour impossible.",
        });
      } finally {
        setEnCours(null);
      }
    },
    [memoire],
  );

  const changeMode = useCallback(
    async (categorie: string, mode: Mode) => {
      const precedents = modes;
      const suivants = { ...precedents, [categorie]: mode };
      setModes(suivants);
      setEnCours(categorie);
      setMessage(null);
      try {
        const reponse = await authFetch("/api/settings/tool-consents", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ modes: suivants }),
        });
        const corps = (await reponse.json().catch(() => ({}))) as { consents?: Record<string, Mode>; error?: string };
        if (!reponse.ok) throw new Error(corps.error || "Mise à jour impossible.");
        setModes(corps.consents ?? suivants);
        setMessage({ ton: "ok", texte: "Consentement mis à jour : la nouvelle règle s'applique immédiatement." });
      } catch (cause) {
        setModes(precedents);
        setMessage({
          ton: "erreur",
          texte: cause instanceof Error ? cause.message : "Mise à jour impossible.",
        });
      } finally {
        setEnCours(null);
      }
    },
    [modes],
  );

  return (
    <section className="g3-gradient-border mt-6 p-6" aria-labelledby="settings-consents-title">
      <h2 id="settings-consents-title" className="font-[family-name:var(--font-display)] text-2xl font-semibold">
        Consentements
      </h2>
      <p className="mt-2 text-sm leading-6 text-[var(--g3-muted)]">
        Décidez, catégorie par catégorie, de ce que Gen3ia a le droit de faire en votre nom.
        Chaque choix s&apos;applique immédiatement et reste modifiable à tout moment.
      </p>

      <fieldset className="mt-4 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-4" disabled={enCours !== null}>
        <legend className="px-1 text-sm font-semibold text-[var(--g3-text)]">Traitement mémoire</legend>
        <label className="mt-2 flex items-start gap-3 text-sm leading-6 text-[var(--g3-text)]">
          <input
            type="checkbox"
            className="mt-1.5 h-4 w-4 accent-[var(--g3-primary)]"
            checked={memoire === true}
            disabled={memoire === null || enCours !== null}
            onChange={(event) => void changeMemoire(event.target.checked)}
          />
          <span>
            Autoriser Gen3ia à utiliser ma mémoire personnalisée (souvenirs, préférences) pour enrichir les conversations.
            <span className="mt-1 block text-xs leading-5 text-[var(--g3-muted)]">
              Le retrait est immédiat ; vos données existantes ne sont pas supprimées — l&apos;effacement se fait dans « Mes données » ci-dessus.
            </span>
          </span>
        </label>
      </fieldset>

      <div className="mt-4 space-y-3">
        {categories.map((categorie) => (
          <fieldset
            key={categorie.id}
            className="rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-4"
            disabled={enCours !== null}
          >
            <legend className="px-1 text-sm font-semibold text-[var(--g3-text)]">{categorie.label}</legend>
            <div className="mt-2 space-y-2">
              {(["ask", "always", "deny"] as Mode[]).map((mode) => (
                <label key={mode} className="flex items-start gap-3 text-sm leading-6 text-[var(--g3-text)]">
                  <input
                    type="radio"
                    name={`consent-${categorie.id}`}
                    className="mt-1.5 h-4 w-4 accent-[var(--g3-primary)]"
                    checked={(modes[categorie.id] ?? "ask") === mode}
                    disabled={enCours !== null}
                    onChange={() => void changeMode(categorie.id, mode)}
                  />
                  <span>
                    {LIBELLES_MODES[mode]}
                    <span className="mt-0.5 block text-xs leading-5 text-[var(--g3-muted)]">
                      {DESCRIPTIONS_MODES[mode]}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ))}
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
        {message
          ? message.texte
          : "Vos choix sont enregistrés sur votre compte et suivent toutes vos sessions."}
      </p>
    </section>
  );
}
