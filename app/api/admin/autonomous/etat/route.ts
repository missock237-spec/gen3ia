import { NextResponse, type NextRequest } from "next/server";

import { requireAdmin } from "@/lib/security/admin-access";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { getCoeurAutonome } from "@/lib/autonomous/core/orchestrator";
import { FileLots } from "@/lib/autonomous/pipeline/queue";
import { RegistreSources } from "@/lib/autonomous/acquisition/source-registry";
import { MemoireConnaissances } from "@/lib/autonomous/knowledge/memoire-connaissances";
import { RegistreCompetences } from "@/lib/autonomous/skills/moteur-competences";
import { chargerConfigCoeurAutonome } from "@/lib/autonomous/core/config/autonomous-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/autonomous/etat — tableau de supervision du Gen3ia
 * Autonomous Brain (Phase 12 du plan : indicateurs demandés couverts).
 * Lecture seule, bornée, honnête : chaque chiffre est MESURÉ (compteurs
 * réels du core, de la file, du registre, de la mémoire et des compétences).
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return NextResponse.json(errorBody(error, "Administrator access required."), { status: errorStatus(error) });
  }

  const coeur = getCoeurAutonome();
  const dossier = coeur.dossierEtat();
  const config = chargerConfigCoeurAutonome();

  // Files et mémoires : relecture persistée (bornée) — état réel du disque.
  const file = new FileLots(dossier);
  const registre = new RegistreSources(dossier);
  const memoire = new MemoireConnaissances(dossier);
  const competences = new RegistreCompetences(dossier);

  const sante = coeur.etat();
  const tachesFile = file.compteParStatut();

  return NextResponse.json({
    date: new Date().toISOString(),
    core: {
      arme: config.arme,
      actif: coeur.actif(),
      cycle: coeur.cycleCourant(),
      demarreLe: sante.demarreLe,
      persisteLe: sante.persisteLe,
      statutSante: sante.statut,
      modules: sante.modules,
      taches: sante.taches,
      journalRecent: coeur.journal().slice(-5),
    },
    collecteur: {
      dernierCycle: coeur.cycleCourant(),
      cyclesRealises: coeur.cycleCourant(),
      sources: registre.toutes().map((s) => ({
        id: s.id,
        type: s.type,
        licence: s.licence,
        statut: s.statut,
        derniereCollecteLe: s.derniereCollecteLe ?? null,
        derniereErreur: s.derniereErreur ?? null,
        lotsProduits: s.lotsProduits,
      })),
    },
    pipeline: {
      lots: tachesFile,
      total: file.taille(),
    },
    memoire: {
      connaissances: memoire.taille(),
      competences: {
        total: competences.toutes().length,
        validees: competences.validees().length,
        parStatut: Object.entries(
          competences.toutes().reduce<Record<string, number>>((acc, c) => {
            acc[c.statut] = (acc[c.statut] ?? 0) + 1;
            return acc;
          }, {}),
        ),
      },
    },
    erreurs: {
      modulesEnDifficulte: sante.modules.filter((m) => m.echecsConsecutifs > 0).map((m) => ({
        id: m.id,
        echecsConsecutifs: m.echecsConsecutifs,
        dernieresErreurs: m.dernieresErreurs,
      })),
    },
  });
}
