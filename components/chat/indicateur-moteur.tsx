"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { useVisiblePolling } from "@/components/hooks/use-visible-polling";

/**
 * INDICATEUR DE STATUT DU MOTEUR (demande propriétaire, audit du 2 nov. 2026
 * — axe 1 « fiabilité du chat ») : punaise permanente dans la barre haute
 * du chat qui affiche l'état RÉEL du moteur, mesuré sur deux sondes
 * publiques :
 *   - GET /api/status  → { status: "ok" | "degraded", services } (HTTP 503 si dégradé) ;
 *   - GET /api/neural/public-stats → état du moteur Gen3 (cerveau, santé).
 *
 * Le temps de réponse ANNONCÉ est celui encodé côté serveur
 * (CHAT_BUDGET_MS = 35 s, lib/domain/conversations/engine-turn.ts) : au-delà
 * de ce budget, le serveur bascule sur un repli honnête persisté dans le fil
 * (lib/domain/conversations/engine-chat.ts) — jamais de 504 opaque, le
 * message de l'utilisateur reste renvoyable. L'indicateur le dit tel quel.
 *
 * Sobriété : rafraîchissement GATÉ PAR LA VISIBILITÉ (30 s) — onglet en
 * arrière-plan = zéro requête ; retour de visibilité = mesure immédiate.
 * Aucun chiffre fabriqué : ce qui s'affiche est ce que les sondes déclarent ;
 * avant la première mesure, l'état affiché est « vérification… ».
 */

type EtatMoteur =
  | { etat: "verification" }
  | { etat: "operationnel"; mode: string | null }
  | { etat: "degrade" }
  | { etat: "injoignable" };

const TEMPS_ANNONCE_S = 35;

export default function IndicateurMoteur() {
  const [etat, setEtat] = useState<EtatMoteur>({ etat: "verification" });

  const mesurer = useCallback(async () => {
    try {
      const [resStatut, resNeural] = await Promise.all([
        fetch("/api/status", { cache: "no-store" }),
        fetch("/api/neural/public-stats", { cache: "no-store" }),
      ]);
      if (!resStatut.ok) {
        setEtat({ etat: "degrade" });
        return;
      }
      const statut = (await resStatut.json()) as { status?: string };
      let mode: string | null = null;
      if (resNeural.ok) {
        const neural = (await resNeural.json()) as {
          sante?: { mode?: string };
        };
        mode = neural.sante?.mode ?? null;
      }
      setEtat(
        statut.status === "ok"
          ? { etat: "operationnel", mode }
          : { etat: "degrade" },
      );
    } catch {
      setEtat({ etat: "injoignable" });
    }
  }, []);

  useEffect(() => {
    void mesurer();
  }, [mesurer]);

  useVisiblePolling(() => void mesurer(), 30_000);

  const rendu = (() => {
    switch (etat.etat) {
      case "operationnel":
        return {
          libelle: "Moteur Gen3 opérationnel",
          titre: modeTexte(etat.mode),
          couleur: "var(--g3-success, #22c55e)",
        };
      case "degrade":
        return {
          libelle: "Moteur Gen3 dégradé",
          titre:
            "Un service est dégradé (voir l'état du service). Le chat reste servi : en cas de lenteur, une réponse de repli honnête est envoyée dans le fil.",
          couleur: "var(--g3-warning, #f59e0b)",
        };
      case "injoignable":
        return {
          libelle: "Moteur injoignable",
          titre:
            "Les sondes de statut ne répondent pas. Le chat basculera sur une réponse de repli honnête si le moteur ne répond pas dans son budget.",
          couleur: "var(--g3-danger, #ef4444)",
        };
      default:
        return {
          libelle: "Vérification du moteur…",
          titre: "Première mesure en cours (sondes /api/status et /api/neural/public-stats).",
          couleur: "var(--g3-faint, #8a8f98)",
        };
    }
  })();

  return (
    <Link
      href="/status"
      className="nova-moteur-punaise"
      title={`${rendu.titre} Temps de réponse annoncé : ${TEMPS_ANNONCE_S} s au plus — au-delà, une réponse de repli honnête est envoyée dans le fil et votre message reste renvoyable. Détail des services : page État du service.`}
      /* a11y (axe label-content-name-mismatch) : le nom accessible DOIT
       * contenir le texte visible de la punaise (« {libelle} » + « X s max ·
       * repli garanti ») — les détails vivent dans title, pas dans le nom. */
      aria-label={`${rendu.libelle} ${TEMPS_ANNONCE_S} s max · repli garanti — voir l'état du service.`}
    >
      <span
        className="nova-moteur-point"
        style={{ background: rendu.couleur }}
        aria-hidden="true"
      />
      <span className="nova-moteur-libelle">{rendu.libelle}</span>
      {/* a11y (axe label-content-name-mismatch) : SANS cet espace réel, le DOM
       * concatène « opérationnel35 s max » et le nom accessible (« … 35 s max
       * … ») ne contient plus le texte visible — violation WCAG 2.1 AA. */}
      {" "}
      <span className="nova-moteur-temps">{TEMPS_ANNONCE_S} s max · repli garanti</span>
    </Link>
  );
}

function modeTexte(mode: string | null): string {
  if (!mode) {
    return "Sondes opérationnelles (état du noyau non détaillé).";
  }
  return `Sondes opérationnelles — mode du noyau : ${mode}.`;
}
