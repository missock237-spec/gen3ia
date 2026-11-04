import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { franchirPorteV1, ErrorAccesV1 } from "@/lib/api/v1/porte-v1";
import { errorStatus } from "@/lib/security/http-errors";

/**
 * GET /api/v1/agents-os/daemon — SONDE DU DAEMON D'AUTO-GUÉRISON (Module 1).
 *
 * Expose le journal des remédiations (JSONL écrit par lib/agents-os/
 * auto-guerison/remediateur.ts) : chaque entrée porte la détection, le refus
 * éventuel (niveau non armé, cooldown) et le résultat d'exécution. C'est la
 * télémétrie HTTPS du daemon — observable sans SSH, même philosophie que
 * /poller-heartbeat.json.
 *
 * Auth : clé développeur `g3a_` (Bearer ou x-api-key) via franchirPorteV1.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const porte = await franchirPorteV1(request, "agents-os-daemon", { limit: 60, windowMs: 60_000 });

    const parametres = request.nextUrl.searchParams;
    const limite = Math.min(500, Math.max(1, Number(parametres.get("limite") ?? 50) || 50));

    const repertoire = process.env.AGENTS_OS_ETAT_DIR
      ? path.resolve(process.env.AGENTS_OS_ETAT_DIR)
      : path.join(process.cwd(), "var", "agents-os");
    const cheminJournal = path.join(repertoire, "remediation.jsonl");

    const entries = lireJournal(cheminJournal, limite);

    return NextResponse.json(
      {
        service: "agents-os/auto-guerison",
        journal: cheminJournal,
        journalExiste: entries.length > 0,
        entries,
        configuration: {
          niveauArme: process.env.AGENTS_OS_NIVEAU ?? "diagnostic (défaut)",
          sources: (process.env.AGENTS_OS_LOGS ?? "défaut PM2 (gen3ia, worker)").split(",").map((s) => s.trim()).filter(Boolean),
        },
        requestId,
      },
      {
        status: 200,
        headers: { "x-request-id": requestId, "cache-control": "no-store", ...porte.enTetesLimite },
      },
    );
  } catch (error) {
    if (error instanceof ErrorAccesV1) {
      return NextResponse.json(
        { error: error.message, requestId },
        { status: error.statut, headers: { "x-request-id": requestId, ...error.enTetes } },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "erreur interne", requestId },
      { status: errorStatus(error), headers: { "x-request-id": requestId } },
    );
  }
}

/** Lecture best-effort des N dernières entrées JSONL. */
function lireJournal(chemin: string, limite: number): unknown[] {
  try {
    if (!fs.existsSync(chemin)) return [];
    const texte = fs.readFileSync(chemin, "utf8").trim();
    if (!texte) return [];
    const resultats: unknown[] = [];
    for (const ligne of texte.split("\n").slice(-limite)) {
      try {
        resultats.push(JSON.parse(ligne));
      } catch {
        // Ligne partielle (écriture en cours) : ignorée, jamais de crash.
      }
    }
    return resultats;
  } catch {
    return [];
  }
}
