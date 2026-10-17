"use client";

import { use } from "react";

import { TrainingProjectWorkspace } from "@/components/training/project-workspace";

import "../training.css";

/**
 * /workspace/training/[projectId] — espace projet du AI Training Studio.
 * Parcours en 7 étapes : Projet · Modèle · Données · Analyse · Entraînement ·
 * Évaluation · Export (voir components/training/project-workspace.tsx).
 */
export default function TrainingProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  return <TrainingProjectWorkspace projectId={projectId} />;
}
