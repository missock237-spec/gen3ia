import { NextResponse, type NextRequest } from "next/server";

import { requireAdmin } from "@/lib/security/admin-access";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { getCoeurAutonome } from "@/lib/autonomous/core/orchestrator";
import { GestionnaireTaches } from "@/lib/autonomous/core/task-manager";
import { agentCollecteur } from "@/lib/autonomous/acquisition/collecteur";
import { RegistreSources } from "@/lib/autonomous/acquisition/source-registry";
import { FileLots } from "@/lib/autonomous/pipeline/queue";
import { agentTraitement } from "@/lib/autonomous/pipeline/worker";
import { MemoireConnaissances } from "@/lib/autonomous/knowledge/memoire-connaissances";
import { verifierAccesEntrainement } from "@/lib/autonomous/privacy/firewall";
import { dossierEtatParDefaut } from "@/lib/autonomous/core/lifecycle-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CorpsCommande {
  action: "pause-source" | "activer-source" | "collecte-maintenant";
  sourceId?: string;
}

/**
 * POST /api/admin/autonomous/commandes — commandes administratives du
 * Gen3ia Autonomous Brain (Lot 08). PROTÉGÉES : requireAdmin cryptographique
 * (aucune mutation publique). Chaque commande s'exécute pour de VRAI sur
 * l'état persistant du dossier du core — aucun effet simulé.
 */
export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return NextResponse.json(errorBody(error, "Administrator access required."), { status: errorStatus(error) });
  }

  let corps: CorpsCommande;
  try {
    corps = (await request.json()) as CorpsCommande;
  } catch {
    return NextResponse.json(errorBody(new Error("corps JSON invalide"), "corps JSON invalide"), { status: 400 });
  }

  const dossier = dossierEtatParDefaut();
  const registre = new RegistreSources(dossier);
  const file = new FileLots(dossier);
  const memoire = new MemoireConnaissances(dossier);

  try {
    if (corps.action === "pause-source" || corps.action === "activer-source") {
      if (!corps.sourceId) {
        return NextResponse.json(errorBody(new Error("sourceId requis"), "sourceId requis"), { status: 400 });
      }
      const ok = registre.definirStatut(corps.sourceId, corps.action === "pause-source" ? "pause" : "actif", "commande administrateur");
      if (!ok) {
        return NextResponse.json(errorBody(new Error("source inconnue"), "source inconnue"), { status: 404 });
      }
      registre.persister();
      return NextResponse.json({ ok: true, action: corps.action, sourceId: corps.sourceId, persiste: true });
    }

    if (corps.action === "collecte-maintenant") {
      // Exécution RÉELLE d'un cycle collecte+traitement (awaited, borné),
      // avec traçabilité réelle (GestionnaireTaches).
      const coeur = getCoeurAutonome();
      const cycle = coeur.cycleCourant() + 1;
      const contexte = () => ({
        cycle,
        dateIso: new Date().toISOString(),
        taches: new GestionnaireTaches(),
        evenementsRecus: [],
        emettreEvenement() {},
      });
      const collecteur = agentCollecteur({ registre, file, timeoutMs: 15_000 });
      const tacheCollecte = await collecteur.tick(contexte());
      const worker = agentTraitement({ file, memoire, registre, dossierCore: dossier, lotsParTick: 3 });
      const tacheTraitement = await worker.tick(contexte());
      return NextResponse.json({
        ok: true,
        action: "collecte-maintenant",
        collecte: { statut: tacheCollecte.statut, message: tacheCollecte.message },
        traitement: { statut: tacheTraitement.statut, message: tacheTraitement.message },
        file: file.compteParStatut(),
        memoire: memoire.taille(),
        isolation: verifierAccesEntrainement("pipeline/lots", dossier).autorise,
      });
    }

    return NextResponse.json(errorBody(new Error("action inconnue"), "action inconnue"), { status: 400 });
  } catch (erreur) {
    return NextResponse.json(
      errorBody(erreur, "commande administrateur échouée (fail-soft — état persistant intact)"),
      { status: 500 },
    );
  }
}
