"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { useVisiblePolling } from "@/components/hooks/use-visible-polling";

/**
 * VUE UTILISATEUR DE LA SOBRIÉTÉ ÉNERGÉTIQUE (it.75 — candidat №2 déclaré
 * it.74 §7 : « intégrer le compteur (profil actif + fenêtres évitées) à la
 * page /vocation ou /status — la mesure devient visible sans curl »).
 *
 * Composant CLIENT public : consomme GET /api/energie (endpoint public
 * it.74, no-store, 807 B) et affiche CE QUE LE SERVEUR DÉCLARE ET MESURE —
 * profil d'énergie actif ET SA SOURCE, compteur réel de fenêtres neuronales
 * exécutées vs évitées (sommes d'entiers mesurés, jamais estimées), règle
 * d'honnêteté. Aucun chiffre n'est fabriqué côté client : ce qui s'affiche
 * est CE QUE LE PROCESSUS DE PRODUCTION COMPTE.
 *
 * Sobriété du widget lui-même : le rafraîchissement périodique est GATÉ PAR
 * LA VISIBILITÉ (hook useVisiblePolling, 30 s) — onglet en arrière-plan =
 * zéro requête ; retour de visibilité = rafraîchissement immédiat. Un
 * indicateur de sobriété qui pollerait en tâche de fond serait une
 * contradiction ; il ne le fait pas.
 */

interface ReponseEnergie {
  profil?: {
    actif?: string;
    source?: string;
    description?: string;
  };
  varEnv?: string;
  compteur?: {
    fenetresExecutees?: number;
    fenetresEvitees?: number;
    epoquesRPIAEvitees?: number;
    cyclesNoyauEvites?: number;
    demarrageIso?: string;
  };
  pontVocation?: {
    reponsesServies?: number;
    refusHonnêtes?: number;
    demarrageIso?: string;
    perimetre?: string;
  };
  honnetete?: {
    regle?: string;
    qualite?: string;
    mesure?: string;
    priorite?: string;
  };
}

const NB_FENETRES_AVERTI = 5;

function fmtFr(n: number | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("fr-FR") : "—";
}

function heureLocale(iso: string | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}

export default function VueSobrieteEnergie() {
  const [energie, setEnergie] = useState<ReponseEnergie | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  const rafraichir = useCallback(async () => {
    try {
      const res = await fetch("/api/energie", { cache: "no-store" });
      const json = (await res.json()) as ReponseEnergie;
      if (!res.ok) {
        setErreur(`Endpoint énergie indisponible (${res.status}) — réessayez.`);
        setEnergie(null);
        return;
      }
      setErreur(null);
      setEnergie(json);
    } catch {
      setErreur("Réseau indisponible — réessayez.");
      setEnergie(null);
    }
  }, []);

  useEffect(() => {
    void rafraichir();
  }, [rafraichir]);

  // Rafraîchissement visibilité-gaté : zéro requête en arrière-plan.
  useVisiblePolling(() => void rafraichir(), 30_000);

  const profil = energie?.profil;
  const compteur = energie?.compteur;
  const pont = energie?.pontVocation;
  const evitees = compteur?.fenetresEvitees ?? 0;
  const executees = compteur?.fenetresExecutees ?? 0;
  const total = evitees + executees;
  const partEvitees = total > 0 ? Math.round((evitees / total) * 100) : null;

  return (
    <section aria-label="Sobriété énergétique du serveur — profil actif et mesure réelle" className="g3v6-card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-bold">Sobriété énergétique — la mesure, en direct</h2>
        <button
          type="button"
          onClick={() => void rafraichir()}
          className="rounded-full border border-[var(--g3-border)] px-3 py-1 text-[11px] text-[var(--g3-muted)] transition hover:bg-[var(--g3-hover)]"
        >
          Rafraîchir
        </button>
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-[var(--g3-muted)]">
        La demande propriétaire — « diminuer la consommation d&apos;énergie de gen3 tout en gardant sa qualité de
        réponse » — est tenue et mesurée sur DEUX périmètres disjoints, tous deux réels : les questions du cadre
        posées au testeur ci-dessus sont servies par le pont vocation SANS AUCUNE fenêtre moteur (compteur du
        pont) ; les conversations complètes du moteur évitent la fenêtre neuronale grâce au profil éco (compteur
        du moteur, même texte testé A/B it.73). Sommes d&apos;entiers mesurées, jamais estimées (rafraîchissement
        30 s, gaté par la visibilité de l&apos;onglet : zéro requête en arrière-plan).
      </p>

      {erreur ? (
        <p className="mt-3 rounded-xl border border-[var(--g3-border)] px-3 py-2 text-[12px] text-[var(--g3-muted)]">
          {erreur}
        </p>
      ) : profil && compteur ? (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="rounded-full border border-[var(--g3-border)] px-3 py-1">
              Profil actif : <strong className="text-[var(--g3v6-spike-text)]">{profil.actif ?? "—"}</strong>
            </span>
            <span className="rounded-full border border-[var(--g3-border)] px-3 py-1">
              Source : {profil.source ?? "—"}
            </span>
            <span className="rounded-full border border-[var(--g3-border)] px-3 py-1">
              Démarrage du compteur : {heureLocale(compteur.demarrageIso)}
            </span>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            <div className="rounded-xl border border-[var(--g3-border)] p-3">
              <p className="text-[10px] font-semibold uppercase tracking-[var(--g3v6-track)] text-[var(--g3-faint)]">
                Réponses du pont — sans fenêtre
              </p>
              <p className="mt-1 text-xl font-bold text-[var(--g3v6-spike-text)]">{fmtFr(pont?.reponsesServies)}</p>
              <p className="text-[10px] text-[var(--g3-faint)]">
                questions du cadre servies ci-dessus, zéro fenêtre moteur (tout profil)
              </p>
            </div>
            <div className="rounded-xl border border-[var(--g3-border)] p-3">
              <p className="text-[10px] font-semibold uppercase tracking-[var(--g3v6-track)] text-[var(--g3-faint)]">
                Refus honnêtes (hors cadre)
              </p>
              <p className="mt-1 text-xl font-bold">{fmtFr(pont?.refusHonnêtes)}</p>
              <p className="text-[10px] text-[var(--g3-faint)]">aucune réponse fabriquée, comptés comme tels</p>
            </div>
            <div className="rounded-xl border border-[var(--g3-border)] p-3">
              <p className="text-[10px] font-semibold uppercase tracking-[var(--g3v6-track)] text-[var(--g3-faint)]">
                Fenêtres moteur évitées
              </p>
              <p className="mt-1 text-xl font-bold">{fmtFr(evitees)}</p>
              <p className="text-[10px] text-[var(--g3-faint)]">
                chat/génération — {partEvitees !== null ? `${partEvitees} % des ${fmtFr(total)}` : "profil éco"}
              </p>
            </div>
            <div className="rounded-xl border border-[var(--g3-border)] p-3">
              <p className="text-[10px] font-semibold uppercase tracking-[var(--g3v6-track)] text-[var(--g3-faint)]">
                Fenêtres moteur exécutées
              </p>
              <p className="mt-1 text-xl font-bold">{fmtFr(executees)}</p>
              <p className="text-[10px] text-[var(--g3-faint)]">hors cadre (chemin historique complet)</p>
            </div>
            <div className="rounded-xl border border-[var(--g3-border)] p-3">
              <p className="text-[10px] font-semibold uppercase tracking-[var(--g3v6-track)] text-[var(--g3-faint)]">
                Époques RPIA évitées
              </p>
              <p className="mt-1 text-xl font-bold">{fmtFr(compteur.epoquesRPIAEvitees)}</p>
              <p className="text-[10px] text-[var(--g3-faint)]">travail neuronal non exécuté, compté</p>
            </div>
            <div className="rounded-xl border border-[var(--g3-border)] p-3">
              <p className="text-[10px] font-semibold uppercase tracking-[var(--g3v6-track)] text-[var(--g3-faint)]">
                Cycles noyau évités
              </p>
              <p className="mt-1 text-xl font-bold">{fmtFr(compteur.cyclesNoyauEvites)}</p>
              <p className="text-[10px] text-[var(--g3-faint)]">travail neuronal non exécuté, compté</p>
            </div>
          </div>

          {evitees >= NB_FENETRES_AVERTI || (pont?.reponsesServies ?? 0) >= NB_FENETRES_AVERTI ? null : (
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--g3-faint)]">
              Les compteurs démarrent à zéro à chaque redéploiement (limite déclarée dans /api/energie) — posez
              une question du cadre ci-dessus, rafraîchissez, la mesure bouge : c&apos;est le serveur qui compte,
              pas cette page.
            </p>
          )}

          <p className="mt-2 text-[11px] leading-relaxed text-[var(--g3-faint)]">{profil.description ?? ""}</p>
          <p className="mt-1 text-[11px] leading-relaxed text-[var(--g3-faint)]">
            Règle : {energie?.honnetete?.regle ?? ""} Qualité : {energie?.honnetete?.qualite ?? ""}
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href="/mobile"
              className="rounded-xl border border-[var(--g3-border)] px-4 py-2 text-[12px] text-[var(--g3-muted)] transition hover:bg-[var(--g3-hover)]"
            >
              Tester gen3 sur téléphone (moteur SNN compact embarqué, zéro requête serveur par question)
            </Link>
          </div>
        </>
      ) : (
        <p className="mt-3 text-[12px] text-[var(--g3-muted)]">Lecture du compteur d&apos;énergie…</p>
      )}
    </section>
  );
}
