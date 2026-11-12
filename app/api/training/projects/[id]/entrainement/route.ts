import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";

import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus } from "@/lib/security/http-errors";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { downloadFromR2 } from "@/lib/storage/r2";

import { getProject, getDataset } from "@/lib/training/repository";
import { ipFromRequest, recordTrainingAudit } from "@/lib/training/audit";

import {
  ErreurEntrainementStudio,
  executerEntrainementStudio,
  lireRapportEntrainement,
  telechargerRessourceUrl,
  type RessourceChargee,
} from "@/lib/studio/pipeline-entrainement";

export const maxDuration = 300;

/* ------------------------------------------------------------------ */
/* STUDIO D'ENTRAÎNEMENT — LANCEMENT DE L'ENTRAÎNEMENT RÉEL            */
/*                                                                    */
/* Étend le projet du Studio (aucun système parallèle) :               */
/*   POST /api/training/projects/[id]/entrainement                     */
/*     ressources { textes, datasetIds, urls } + domaine               */
/*     → extraction de corpus → mémoire de domaine PAR UTILISATEUR     */
/*       (persistée dans l'espace utilisateur) → évaluation AVANT/     */
/*       APRÈS (questions du domaine + contrôle hors domaine) →        */
/*       FICHIER FINAL gen3iac-entrainement-<projet>.json (lien        */
/*       durable via l'espace permanent).                              */
/*   GET  /api/training/projects/[id]/entrainement                     */
/*     → le DERNIER rapport d'entraînement du projet.                  */
/*                                                                    */
/* Honnêteté : chaque ressource ignorée est comptée et expliquée —     */
/* aucun entraînement n'est marqué réussi sans gain mesuré (le         */
/* pipeline échoue 422 sinon) ; aucun poids neuronal n'est modifié     */
/* (mémoire de connaissance réelle — cf. note du fichier final).       */
/* ------------------------------------------------------------------ */

const lancerSchema = z.object({
  /** Domaine choisi par l'utilisateur (libre, normalisé en segment sûr). */
  domaine: z.string().trim().min(2).max(60),
  /** Textes collés (max 5 × 4 Mo). */
  textes: z
    .array(
      z.object({
        titre: z.string().trim().min(1).max(180),
        contenu: z.string().min(1).max(4_000_000),
      }),
    )
    .max(5)
    .optional()
    .default([]),
  /** Datasets déjà importés dans le projet (json/jsonl/csv/txt valides). */
  datasetIds: z.array(z.string().trim().min(1).max(128)).max(10).optional().default([]),
  /** Pages web publiques à ingérer (max 5 — SSRF gardé, plafond 1 Mo/page). */
  urls: z.array(z.string().trim().min(3).max(600)).max(5).optional().default([]),
});

/** POST — lance l'entraînement RÉEL de l'IA du compte sur le domaine choisi. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const project = await getProject(user.uid, id);
    if (!project) {
      return NextResponse.json(
        { error: "Projet introuvable.", requestId },
        { status: 404, headers: { "x-request-id": requestId } },
      );
    }

    // Un entraînement consomme du CPU (extraction + évaluation) : 6 par 10 min.
    const limit = await enforceRateLimit(`training-entrainement:${user.uid}`, {
      limit: 6,
      windowMs: 10 * 60_000,
    });
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Trop d'entraînements lancés : réessayez dans quelques minutes.", requestId },
        { status: 429, headers: { "x-request-id": requestId } },
      );
    }

    const parsed = lancerSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        {
          error:
            "Requête d'entraînement invalide : domaine (2-60), textes (≤5), datasetIds (≤10), urls (≤5).",
          requestId,
        },
        { status: 400, headers: { "x-request-id": requestId } },
      );
    }
    const { domaine, textes, datasetIds, urls } = parsed.data;
    if (textes.length + datasetIds.length + urls.length === 0) {
      return NextResponse.json(
        { error: "Aucune ressource fournie : ajoutez au moins un texte, un dataset ou une URL.", requestId },
        { status: 400, headers: { "x-request-id": requestId } },
      );
    }

    // ── Chargement des ressources (I/O du pipeline) ──────────────────────
    const ressources: RessourceChargee[] = [];
    const defaillances: string[] = [];

    for (const texte of textes) {
      ressources.push({ titre: texte.titre, contenu: texte.contenu, origine: "texte" });
    }

    for (const datasetId of datasetIds) {
      const dataset = await getDataset(user.uid, id, datasetId).catch(() => null);
      if (!dataset || dataset.status !== "valid") {
        defaillances.push(`Dataset ${datasetId} introuvable ou non valide dans ce projet.`);
        continue;
      }
      try {
        const tampon = await downloadFromR2(dataset.storageKey, 6 * 1024 * 1024);
        ressources.push({
          // Le NOM porte l'extension (json/jsonl/csv/txt) : le détecteur de
          // format structuré de l'extraction s'appuie dessus.
          titre: dataset.name,
          contenu: tampon.toString("utf-8"),
          origine: "dataset",
        });
      } catch {
        defaillances.push(`Dataset ${dataset.name} illisible dans le stockage : ignoré.`);
      }
    }

    for (const url of urls) {
      try {
        const page = await telechargerRessourceUrl(url);
        ressources.push({ titre: page.titre, contenu: page.contenu, origine: "url" });
      } catch (error) {
        defaillances.push(
          `URL ${url.slice(0, 120)} : ${error instanceof Error ? error.message : "téléchargement impossible"}.`,
        );
      }
    }

    if (ressources.length === 0) {
      return NextResponse.json(
        {
          error: `Aucune ressource exploitable. ${defaillances.slice(0, 6).join(" ")}`.trim(),
          requestId,
        },
        { status: 400, headers: { "x-request-id": requestId } },
      );
    }

    // ── Pipeline réel (extraction → baseline → ingestion → mesure → livraison) ──
    const resultat = await executerEntrainementStudio(user.uid, {
      projet: { id: project.id, nom: project.name },
      domaine,
      ressources,
    });

    void recordTrainingAudit({
      uid: user.uid,
      action: "project.entrainement",
      entityType: "project",
      entityId: project.id,
      projectId: project.id,
      ip: ipFromRequest(request),
      details: {
        domaine: resultat.rapport.domaine,
        unites: resultat.rapport.corpus.unites,
        avant: resultat.rapport.evaluation.avant.scoreGlobal,
        apres: resultat.rapport.evaluation.apres.scoreGlobal,
        fichier: resultat.rapport.fichierFinal.nom,
      },
    }).catch(() => undefined);

    return NextResponse.json(
      { ...resultat, defaillances, requestId },
      { status: 201, headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    if (error instanceof ErreurEntrainementStudio) {
      return NextResponse.json(
        { error: error.message, code: error.code, requestId },
        { status: 422, headers: { "x-request-id": requestId } },
      );
    }
    return NextResponse.json(
      { ...errorBody(error, "Entraînement impossible"), requestId },
      { status: errorStatus(error, 500), headers: { "x-request-id": requestId } },
    );
  }
}

/** GET — le DERNIER rapport d'entraînement du projet (null si jamais lancé). */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const project = await getProject(user.uid, id);
    if (!project) {
      return NextResponse.json(
        { error: "Projet introuvable.", requestId },
        { status: 404, headers: { "x-request-id": requestId } },
      );
    }
    const rapport = await lireRapportEntrainement(user.uid, id);
    if (!rapport) {
      return NextResponse.json(
        { error: "Aucun entraînement lancé pour ce projet.", requestId },
        { status: 404, headers: { "x-request-id": requestId } },
      );
    }
    return NextResponse.json({ rapport, requestId }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return NextResponse.json(
      { ...errorBody(error, "Rapport d'entraînement indisponible"), requestId },
      { status: errorStatus(error, 500), headers: { "x-request-id": requestId } },
    );
  }
}
