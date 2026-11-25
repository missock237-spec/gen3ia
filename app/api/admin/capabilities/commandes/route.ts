import { NextResponse, type NextRequest } from "next/server";

import { requireAdmin } from "@/lib/security/admin-access";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { obtenirGestionnaireCapacites } from "@/lib/capabilities/core/capability-manager";
import { decouvrirUniversellement } from "@/lib/capabilities/discovery/universal-discovery";
import { benchmarker } from "@/lib/capabilities/evaluation/benchmark-engine";
import { effectuerRollback } from "@/lib/capabilities/versioning/rollback-manager";
import { refuserSiSecret } from "@/lib/capabilities/security/secrets-protection";
import { promouvoirVersion } from "@/lib/capabilities/versioning/version-manager";
import { definirNiveauAutonomie, NIVEAUX_AUTONOMIE } from "@/lib/capabilities/autonomy/autonomy-policy-engine";
import { obtenirOrchestrateurCycle } from "@/lib/capabilities/core/cycle-persistant";
import { obtenirRegistreCentral } from "@/lib/capabilities/core/capability-registry";
import { promises as fs } from "node:fs";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface CorpsCommande {
  action:
    | "lancer-decouverte"
    | "tester-capacite"
    | "activer-capacite"
    | "desactiver-capacite"
    | "autoriser-integration"
    | "rollback"
    | "promouvoir-version"
    | "suspendre-evolutions"
    | "reprendre-evolutions"
    // V1.1 Phase 13 — supervision de l'autonomie :
    | "niveau-autonomie"
    | "annuler-cycle"
    | "reprendre-cycle"
    | "relancer-cycle"
    | "reprendre-cycles-interrompus"
    | "rollback-cycle";
  requete?: string;
  capabilityId?: string;
  script?: string;
  autorisePar?: string;
  versVersionId?: string;
  raison?: string;
  versionId?: string;
  cycleId?: string;
  niveau?: number;
}

/**
 * POST /api/admin/capabilities/commandes — commandes administratives UCE
 * (mission §10) : découverte, test sandbox, activation/désactivation,
 * AUTORISATION d'intégration (gate humain), rollback, promotion de version,
 * suspension des évolutions. Chaque commande s'exécute pour de VRAI —
 * aucun effet simulé, réponse honnête.
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

  const gestionnaire = obtenirGestionnaireCapacites();

  try {
    switch (corps.action) {
      case "lancer-decouverte": {
        const requete = (corps.requete ?? "").slice(0, 120);
        if (!requete) return NextResponse.json(errorBody(new Error("requete requise"), "requete requise"), { status: 400 });
        const garde = refuserSiSecret(requete);
        if (!garde.autorise) return NextResponse.json(errorBody(new Error(garde.cause ?? "contenu refusé"), garde.cause ?? "contenu refusé"), { status: 400 });
        const rapport = await decouvrirUniversellement({ requete, limiteParSource: 3 });
        return NextResponse.json({
          ok: true,
          decouverte: {
            total: rapport.totalDecouvertes,
            doublonsIgnores: rapport.doublonsIgnores,
            sources: rapport.sources,
            capacitesCreees: rapport.capacitesCreees.length,
          },
        });
      }

      case "tester-capacite": {
        if (!corps.capabilityId || !corps.script) {
          return NextResponse.json(errorBody(new Error("capabilityId et script requis"), "capabilityId et script requis"), { status: 400 });
        }
        const garde = refuserSiSecret(corps.script);
        if (!garde.autorise) return NextResponse.json(errorBody(new Error(garde.cause ?? "script refusé"), garde.cause ?? "script refusé"), { status: 400 });
        const resultat = await benchmarker(corps.capabilityId, { nom: "test-admin", script: corps.script.slice(0, 8_000) }, { runs: 3 });
        return NextResponse.json({
          ok: resultat.verdict !== "echec",
          verdict: resultat.verdict,
          stats: resultat.benchmark.stats,
          cause: resultat.cause,
        });
      }

      case "activer-capacite":
      case "desactiver-capacite": {
        if (!corps.capabilityId) {
          return NextResponse.json(errorBody(new Error("capabilityId requis"), "capabilityId requis"), { status: 400 });
        }
        const registre = obtenirRegistreCentral();
        // Outils NATIFS : contrôle d'activation du registre central (V1.1
        // Phase 2 — une capacité désactivée n'est plus exécutable, contrôle
        // branché dans le gateway). Capacités UCE : machine à états.
        if (corps.capabilityId.startsWith("natif:")) {
          const par = (corps.autorisePar ?? "").trim();
          if (par.length < 4) {
            return NextResponse.json(errorBody(new Error("autorisePar requis (identifiant humain)"), "autorisePar requis (identifiant humain)"), { status: 400 });
          }
          const raison = (corps.raison ?? `${corps.action} par l'admin`).slice(0, 300);
          const res = corps.action === "desactiver-capacite"
            ? await registre.desactiver(corps.capabilityId, { raison, par })
            : await registre.reactiver(corps.capabilityId, { raison, par });
          return NextResponse.json({ ok: res.ok, raison: res.raison });
        }
        const vers = corps.action === "activer-capacite" ? "evaluee" : "suspendue";
        const res = await gestionnaire.transitionner(corps.capabilityId, vers, {});
        return NextResponse.json({ ok: res.ok, raison: res.raison });
      }

      case "autoriser-integration": {
        if (!corps.capabilityId || !corps.autorisePar) {
          return NextResponse.json(errorBody(new Error("capabilityId et autorisePar requis"), "capabilityId et autorisePar requis"), { status: 400 });
        }
        // Machine à états : proposee → autorisee → integree (gates du manager).
        const gate1 = await gestionnaire.transitionner(corps.capabilityId, "autorisee", { autorisePar: corps.autorisePar });
        if (!gate1.ok) return NextResponse.json({ ok: false, raison: gate1.raison }, { status: 409 });
        const gate2 = await gestionnaire.transitionner(corps.capabilityId, "integree", {});
        return NextResponse.json({ ok: gate2.ok, raison: gate2.raison });
      }

      case "rollback": {
        if (!corps.capabilityId || !corps.versVersionId) {
          return NextResponse.json(errorBody(new Error("capabilityId et versVersionId requis"), "capabilityId et versVersionId requis"), { status: 400 });
        }
        const res = await effectuerRollback({
          capabilityId: corps.capabilityId,
          versVersionId: corps.versVersionId,
          raison: (corps.raison ?? "rollback administrateur").slice(0, 400),
          effectuePar: "admin",
        });
        return NextResponse.json({ ok: res.ok, raison: res.raison, rollback: res.rollback });
      }

      case "promouvoir-version": {
        if (!corps.versionId) {
          return NextResponse.json(errorBody(new Error("versionId requis"), "versionId requis"), { status: 400 });
        }
        const res = await promouvoirVersion(corps.versionId);
        return NextResponse.json({ ok: res.ok, raison: res.raison });
      }

      case "suspendre-evolutions": {
        const dossier = path.join(process.cwd(), "var", "capabilities");
        await fs.mkdir(dossier, { recursive: true });
        await fs.writeFile(path.join(dossier, "evolutions-suspendues.json"), new Date().toISOString(), "utf8");
        return NextResponse.json({ ok: true, suspendues: true });
      }

      case "reprendre-evolutions": {
        await fs.rm(path.join(process.cwd(), "var", "capabilities", "evolutions-suspendues.json"), { force: true });
        return NextResponse.json({ ok: true, suspendues: false });
      }

      // ------------------------------------------------------------------
      // V1.1 Phase 13 — supervision de l'autonomie
      // ------------------------------------------------------------------
      case "niveau-autonomie": {
        const niveau = corps.niveau;
        if (typeof niveau !== "number" || !NIVEAUX_AUTONOMIE.includes(niveau as 1 | 2 | 3 | 4 | 5)) {
          return NextResponse.json(errorBody(new Error("niveau invalide (1-5)"), "niveau invalide (1-5)"), { status: 400 });
        }
        const res = await definirNiveauAutonomie(niveau as 1 | 2 | 3 | 4 | 5, { par: (corps.autorisePar ?? "").trim(), raison: (corps.raison ?? "").trim() });
        return NextResponse.json({ ok: res.ok, raison: res.raison });
      }

      case "annuler-cycle": {
        if (!corps.cycleId) return NextResponse.json(errorBody(new Error("cycleId requis"), "cycleId requis"), { status: 400 });
        const res = await obtenirOrchestrateurCycle().annuler(corps.cycleId, { raison: (corps.raison ?? "annulation admin").slice(0, 300), par: (corps.autorisePar ?? "").trim() });
        return NextResponse.json({ ok: res.ok, raison: res.raison });
      }

      case "reprendre-cycle": {
        if (!corps.cycleId) return NextResponse.json(errorBody(new Error("cycleId requis"), "cycleId requis"), { status: 400 });
        const res = await obtenirOrchestrateurCycle().reprendre(corps.cycleId, { autorisePar: (corps.autorisePar ?? "").trim() || undefined });
        return NextResponse.json({ ok: res.ok, raison: res.raison, etat: res.cycle.etat, approbationRequise: res.approbationRequise ?? false });
      }

      case "relancer-cycle": {
        if (!corps.cycleId) return NextResponse.json(errorBody(new Error("cycleId requis"), "cycleId requis"), { status: 400 });
        const res = await obtenirOrchestrateurCycle().relancer(corps.cycleId);
        return NextResponse.json({ ok: res.ok, raison: res.raison, etat: res.cycle.etat });
      }

      case "reprendre-cycles-interrompus": {
        const res = await obtenirOrchestrateurCycle().reprendreCyclesInterrompus();
        return NextResponse.json({ ok: true, raison: res.message, cycles: res.cycles.map((c) => ({ id: c.id, etat: c.etat })) });
      }

      case "rollback-cycle": {
        if (!corps.cycleId) return NextResponse.json(errorBody(new Error("cycleId requis"), "cycleId requis"), { status: 400 });
        const res = await obtenirOrchestrateurCycle().annulerParRollback(corps.cycleId, { raison: (corps.raison ?? "rollback admin").slice(0, 300), par: (corps.autorisePar ?? "").trim() });
        return NextResponse.json({ ok: res.ok, raison: res.raison });
      }

      default:
        return NextResponse.json(errorBody(new Error("action inconnue"), "action inconnue"), { status: 400 });
    }
  } catch (erreur) {
    return NextResponse.json(
      errorBody(erreur instanceof Error ? erreur : new Error(String(erreur)), "commande échouée"),
      { status: 500 },
    );
  }
}
