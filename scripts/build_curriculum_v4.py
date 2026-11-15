#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Curriculum Gen3ia v4 « tous domaines » — runner.

26 nouveaux datasets = 900 000 lignes exactes, couvrant les 8 catégories de la
feuille de route utilisateur (langage, raisonnement, programmation, outils/RAG,
vision, audio, vidéo, orchestration, entraînement de modèles, sécurité, métiers,
sciences). Total curriculum : 100 000 (v1-v3) + 900 000 (v4) = 1 000 000 LIGNES.

Usage :
  python3 scripts/build_curriculum_v4.py            # génère tout
  python3 scripts/build_curriculum_v4.py --check    # vérifie les MANIFEST existants
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from cv4_core import (SEED, ecrire_dataset_v4, generer_dataset, maj_index_v4)
from cv4_langage import FABRIQUES_NLP, FABRIQUES_GEN, FABRIQUES_CTX, FABRIQUES_MEM, FABRIQUES_INT
from cv4_raisonnement import FABRIQUES_REASONING, FABRIQUES_MATH, FABRIQUES_PROBLEM
from cv4_code_outils import FABRIQUES_CODE, FABRIQUES_TOOLS, FABRIQUES_RAG, FABRIQUES_DB
from cv4_media import (FABRIQUES_IMG_ANALYSIS, FABRIQUES_IMG_GEN, FABRIQUES_VOICE,
                       FABRIQUES_AUDIO, FABRIQUES_MUSIC, FABRIQUES_VIDEO, FABRIQUES_MULTIMODAL)
from cv4_ml_securite import (FABRIQUES_ML_DATA, FABRIQUES_ML_TRAIN, FABRIQUES_ML_EVAL,
                             FABRIQUES_ML_MGMT, FABRIQUES_SEC)
from cv4_metiers_sciences import FABRIQUES_PROFESSIONS, FABRIQUES_SCIENCES

# ═══════════════════ Quotas v4 (somme = 900 000 exactement) ═══════════════════

PLAN = [
    # (nom, préfixe, quota, description courte)
    ("nlp_comprehension", "nlp4", 60_000, "Compréhension de textes : QA vérifiables par construction, idée principale, ordre des événements"),
    ("text_generation", "gen4", 28_000, "Génération : plans + amorce d'articles/emails/histoires/annonces, réécriture de style"),
    ("contextual_understanding", "ctx4", 25_000, "Compréhension contextuelle : résolution de références, questions implicites"),
    ("conversational_memory", "mem4", 20_000, "Mémoire conversationnelle : rappel et combinaison de faits multi-tours"),
    ("intent_recognition", "int4", 33_000, "Reconnaissance d'intention : 20 intentions FR/EN, entités, action suivante"),
    ("reasoning", "rea4", 45_000, "Raisonnement : syllogismes, suites numériques, classements, logique conditionnelle"),
    ("math", "mat4", 125_000, "Mathématiques : calcul exact (priorités, %, équations, géométrie, proportions, taux)"),
    ("problem_solving", "pro4", 25_000, "Résolution de problèmes : plans jalonnés et décisions argumentées"),
    ("code_v4", "cod4", 60_000, "Programmation : React typé, Python calculé, debug, SQL, regex, API REST, complexité, CSS"),
    ("tools", "too4", 35_000, "Utilisation d'outils : appels JSON stricts et chaînes d'appels avec replis"),
    ("rag_documents", "rag4", 20_000, "RAG : réponse ancrée sur politiques paramétrées ; ~17 % non répondables (anti-hallucination)"),
    ("databases", "dat4", 15_000, "Bases de données : SQL de lecture sur 4 schémas métier, agrégats et index"),
    ("image_analysis", "ima4", 35_000, "Analyse d'images : scènes, OCR, lecture de graphiques, comptage spatial"),
    ("image_generation", "img4", 30_000, "Génération d'images : prompts photoréalistes à 8 dimensions, plans de retouche"),
    ("voice_speech", "voc4", 20_000, "Voix : briefs TTS prosodiques, design de voix de marque, éthique"),
    ("audio_understanding", "aud4", 15_000, "Audio : classification d'environnements sonores, plans de transcription"),
    ("music_v4", "mus4", 15_000, "Musique : briefs de composition mesurés (genre, tempo, tonalité, structure)"),
    ("video_v4", "vid4", 45_000, "Vidéo : storyboards keyframes à graines dérivées, sous-titres SRT, math de montage"),
    ("multimodal_v4", "mul4", 30_000, "Orchestration multimodale : pipelines texte→image→voix→vidéo avec replis honnêtes"),
    ("ml_data", "mld4", 15_000, "Préparation de données : dédup calculée, PII, annotation, qualité, collecte conforme"),
    ("ml_training", "mlt4", 15_000, "Entraînement : configs LoRA/QLoRA CALCULÉES, reprise, distillation"),
    ("ml_evaluation", "mle4", 12_000, "Évaluation : grilles et seuils, verdicts performance, A/B, audit de biais"),
    ("ml_management", "mlm4", 12_000, "Gestion : sharding GPU d'essaim, coûts, checkpoints, supervision de convergence"),
    ("security_v4", "sec4", 50_000, "Sécurité STRICTEMENT défensive : revue de code tracée, injection de prompt, hallucinations, empoisonnement, secrets, permissions"),
    ("professions", "prf4", 95_000, "15 métiers : marketing, e-commerce, support, finance, compta, droit, éducation, RH, immobilier, agriculture, logistique, journalisme, tourisme, projets, entrepreneuriat"),
    ("sciences", "sci4", 20_000, "Sciences : 40 faits exacts (physique, chimie, bio, astro, géo, env, élec, robotique) × 3 formats"),
]

QUOTAS = {nom: q for nom, _, q, _ in PLAN}
assert sum(QUOTAS.values()) == 900_000, f"plan v4 = {sum(QUOTAS.values()):,} ≠ 900 000"

FABRIQUES = {
    "nlp_comprehension": FABRIQUES_NLP,
    "text_generation": FABRIQUES_GEN,
    "contextual_understanding": FABRIQUES_CTX,
    "conversational_memory": FABRIQUES_MEM,
    "intent_recognition": FABRIQUES_INT,
    "reasoning": FABRIQUES_REASONING,
    "math": FABRIQUES_MATH,
    "problem_solving": FABRIQUES_PROBLEM,
    "code_v4": FABRIQUES_CODE,
    "tools": FABRIQUES_TOOLS,
    "rag_documents": FABRIQUES_RAG,
    "databases": FABRIQUES_DB,
    "image_analysis": FABRIQUES_IMG_ANALYSIS,
    "image_generation": FABRIQUES_IMG_GEN,
    "voice_speech": FABRIQUES_VOICE,
    "audio_understanding": FABRIQUES_AUDIO,
    "music_v4": FABRIQUES_MUSIC,
    "video_v4": FABRIQUES_VIDEO,
    "multimodal_v4": FABRIQUES_MULTIMODAL,
    "ml_data": FABRIQUES_ML_DATA,
    "ml_training": FABRIQUES_ML_TRAIN,
    "ml_evaluation": FABRIQUES_ML_EVAL,
    "ml_management": FABRIQUES_ML_MGMT,
    "security_v4": FABRIQUES_SEC,
    "professions": FABRIQUES_PROFESSIONS,
    "sciences": FABRIQUES_SCIENCES,
}

PHASES = {
    "nlp_comprehension": "1-langage", "text_generation": "1-langage",
    "contextual_understanding": "1-langage", "conversational_memory": "1-langage",
    "intent_recognition": "1-langage",
    "reasoning": "2-raisonnement", "math": "2-raisonnement", "problem_solving": "2-raisonnement",
    "code_v4": "3-programmation",
    "tools": "4-outils", "rag_documents": "5-rag", "databases": "4-outils",
    "image_analysis": "6-vision", "image_generation": "7-images",
    "voice_speech": "8-audio", "audio_understanding": "8-audio", "music_v4": "8-audio",
    "video_v4": "9-video", "multimodal_v4": "10-orchestration",
    "ml_data": "11-modeles", "ml_training": "11-modeles",
    "ml_evaluation": "11-modeles", "ml_management": "11-modeles",
    "security_v4": "12-securite",
    "professions": "metiers", "sciences": "sciences",
}


def main() -> None:
    parseur = argparse.ArgumentParser()
    parseur.add_argument("--check", action="store_true", help="vérifie sans réécrire")
    args = parseur.parse_args()

    if args.check:
        racine = Path(__file__).resolve().parent.parent / "datasets"
        total = 0
        for nom, _, quota, _ in PLAN:
            man = json.loads((racine / nom / "MANIFEST.json").read_text("utf-8"))
            if man.get("rows") != quota:
                raise SystemExit(f"[check] {nom}: rows {man.get('rows')} ≠ {quota}")
            echantillon = sum(1 for l in (racine / nom / "sample.jsonl").read_text("utf-8").splitlines() if l.strip())
            if echantillon != 200:
                raise SystemExit(f"[check] {nom}: sample {echantillon} ≠ 200")
            total += quota
            print(f"[check] {nom:26s} OK ({quota:,} lignes, sample 200)")
        idx = json.loads((racine / "INDEX.json").read_text("utf-8"))
        bloc = idx["gen3ia-media-datasets"]
        cumul = sum(d["rows"] for d in bloc["datasets"])
        print(f"[check] INDEX : {len(bloc['datasets'])} datasets, {cumul:,} lignes cumulées")
        if cumul != 1_000_000:
            raise SystemExit(f"[check] cumul {cumul:,} ≠ 1 000 000")
        print("[check] CURRICULUM v4 : OK — 1 000 000 lignes exactement")
        return

    rng = random.Random(SEED)
    vus: set[str] = set()   # dédup GLOBALE sur tout le curriculum
    nouveaux: list[dict] = []
    for nom, prefixe, quota, description in PLAN:
        lignes = generer_dataset(nom, prefixe, quota, FABRIQUES[nom], rng, vus)
        ecrire_dataset_v4(nom, lignes, description)
        nouveaux.append({"id": nom, "path": f"datasets/{nom}/train.jsonl",
                         "rows": quota, "phase": PHASES[nom],
                         "data": f"huggingface:Kings237/gen3ia-media-engine@v4/{nom}/train.jsonl"})
    maj_index_v4(nouveaux)
    total_lignes = sum(q for _, _, q, _ in PLAN)
    print(f"\n[v4] TERMINÉ — {len(PLAN)} datasets v4, {total_lignes:,} lignes v4 "
          f"(curriculum complet : 1 000 000 lignes)")


if __name__ == "__main__":
    main()
