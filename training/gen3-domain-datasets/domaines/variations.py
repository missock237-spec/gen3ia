"""
MÉCANIQUE DE VARIATION RICHE — slots combinatoires par langue.

Chaque domaine définit des lexiques (sujets, styles, contraintes, usages...)
et les builders tirent 4-7 dimensions par item : l'espace combinatoire
(> 10⁵ combinaisons/task_type) garantit 100 000 lignes UNIQUEES par domaine
sans répétition mécanique — chaque slot apporte une variation de contenu
réelle (pas du bruit).

Module PUR — stdlib uniquement.
"""

from __future__ import annotations

import random
from typing import Dict, List


class Lex:
    """Lexique multilingue : slot → {"fr": [...], "en": [...]}."""

    def __init__(self, **slots: Dict[str, Dict[str, List[str]]]):
        for slot, pair in slots.items():
            if "fr" not in pair or "en" not in pair:
                raise ValueError(f"Slot {slot} incomplet (fr/en requis)")
            if len(pair["fr"]) != len(pair["en"]):
                raise ValueError(
                    f"Slot {slot} désaligné : {len(pair['fr'])} fr vs "
                    f"{len(pair['en'])} en"
                )
        self.slots = slots

    def tirer(self, rng: random.Random, lang: str) -> Dict[str, str]:
        return {k: rng.choice(v[lang]) for k, v in self.slots.items()}

    def taille(self) -> int:
        n = 1
        for pair in self.slots.values():
            n *= len(pair["fr"])
        return n


def nombre(rng: random.Random, lo: int, hi: int, step: int = 1) -> int:
    """Entier multiple de `step` (valeurs « rondes » crédibles)."""
    options = list(range(lo, hi + 1, step))
    return rng.choice(options)


def pourcentage(rng: random.Random, lo: int, hi: int, step: int = 5) -> str:
    return f"{nombre(rng, lo, hi, step)} %"


def deux_a_quatre(rng: random.Random, banque: List[str], k_min: int = 2) -> List[str]:
    k = rng.randint(k_min, min(4, len(banque)))
    return rng.sample(banque, k=k)


def joindre(elements: List[str], langue: str) -> str:
    if len(elements) <= 1:
        return elements[0] if elements else ""
    if langue == "fr":
        return ", ".join(elements[:-1]) + " et " + elements[-1]
    return ", ".join(elements[:-1]) + " and " + elements[-1]


# ─────────────────────────────────────────────────────────────────────────────
# SLOTS UNIVERSELS — tirés pour CHAQUE exemple, tous domaines confondus :
# le cadre situationnel (où/quand/pour qui) et le critère de succès mesurable.
# Ils multiplient l'espace d'instruction de chaque builder par |CADRE|×|CRITERE|
# (≈ 280) SANS rien inventer : ce sont des dimensions réelles de toute demande.
# ─────────────────────────────────────────────────────────────────────────────

CADRE = {
    "fr": [
        "en atelier avec l'équipe ce matin", "à distance, par messagerie, en fin de journée",
        "pendant une revue hebdomadaire", "juste avant une échéance client",
        "au comptoir, entre deux clients", "en formation avec des débutants",
        "après un incident la veille", "lors d'un audit planifié",
        "au retour d'une mission terrain", "en préparation d'un conseil d'administration",
        "pendant la saison haute", "en début de mois, au moment des rapports",
        "avec un budget serré et un délai court", "après un changement d'outil",
        "pour un nouveau collaborateur", "en relance d'un dossier au repos",
        "sous contrainte de connexion lente", "avec des données partielles à la main",
        "avant une présentation importante", "en fin de trimestre",
    ],
    "en": [
        "at the workshop with the team this morning", "remotely, by chat, end of day",
        "during a weekly review", "right before a client deadline",
        "at the counter, between two customers", "in training with beginners",
        "after yesterday's incident", "during a planned audit",
        "back from a field mission", "while preparing a board meeting",
        "during the high season", "at month start, report time",
        "on a tight budget and short deadline", "after a tool change",
        "for a new team member", "restarting a dormant file",
        "on a slow connection", "with partial data at hand",
        "before an important presentation", "at quarter end",
    ],
}

CRITERE = {
    "fr": [
        "le résultat se vérifie en moins de 5 minutes",
        "un débutant peut suivre la première fois sans aide",
        "le coût total reste sous le budget annoncé",
        "le résultat reste valable dans 6 mois",
        "chaque étape laisse une trace vérifiable",
        "on peut défaire la modification proprement",
        "le temps total ne dépasse pas une heure",
        "le client comprend la décision sans jargon",
        "aucune donnée personnelle n'est exposée",
        "le résultat se reproduit à l'identique une seconde fois",
        "le document tient sur une page lisible",
        "le système reste utilisable en cas d'échec partiel",
        "la mesure avant/après est indiscutable",
        "aucune étape ne dépend d'une personne unique",
    ],
    "en": [
        "the result checks out in under 5 minutes",
        "a beginner can follow it first time without help",
        "total cost stays under the stated budget",
        "the result still holds 6 months from now",
        "every step leaves a verifiable trace",
        "the change can be cleanly undone",
        "total time stays under one hour",
        "the client understands the decision without jargon",
        "no personal data is exposed",
        "the result reproduces identically a second time",
        "the document fits one readable page",
        "the system stays usable on partial failure",
        "the before/after measure is indisputable",
        "no step depends on a single person",
    ],
}


def tirer_contexte(rng: random.Random, lang: str) -> Dict[str, str]:
    """Cadre situationnel + critère de succès pour un exemple."""
    return {
        "cadre": rng.choice(CADRE[lang]),
        "critere": rng.choice(CRITERE[lang]),
    }
