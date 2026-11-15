"""
BASE DU GÉNÉRATEUR DE DATASETS GEN3IA — 18 domaines, bilingue FR/EN.

Ce module fournit les briques partagées par tous les domaines :
  - `SpecDomaine` : contrat d'un domaine (id, noms, types de tâches, builders) ;
  - horloge temporelle réaliste (fenêtre glissante 24 mois, pondération
    récence + rythme hebdomadaire + profil horaire de production) ;
  - déduplication par hachage stable (sha1 sur contenu normalisé) ;
  -scores de qualité cohérents avec la difficulté et la provenance ;
  - rédaction bilingue : chaque item conceptuel produit UNE ligne FR et UNE
    ligne EN liées par `bilingual_pair_id`.

Module PUR — aucune dépendance externe (stdlib uniquement).
"""

from __future__ import annotations

import hashlib
import random
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Callable, Dict, List, Tuple

# ─────────────────────────────────────────────────────────────────────────────
# Horloge temporelle — « meilleures choix temporelles »
# ─────────────────────────────────────────────────────────────────────────────

# Fenêtre glissante de 24 mois se terminant à la date de génération (bornée
# au quantième de référence GEN3IA_ANCRAGE pour la reproductibilité).
GEN3IA_ANCRAGE = datetime(2026, 10, 24, 18, 0, 0, tzinfo=timezone.utc)
FENETRE_MOIS = 24


class HorlogeTemporelle:
    """Tire des horodatages réalistes : récence privilégiée, semaine active,
    nuit calme. Déterministe (rng injecté)."""

    # Profil horaire (UTC+1 Afrique de l'Ouest ~ heures ouvrées) — 24 poids.
    PROFIL_HEURES = [
        0.15, 0.10, 0.08, 0.08, 0.10, 0.20, 0.45, 0.80,  # 00..07
        1.30, 1.60, 1.55, 1.20, 0.95, 1.15, 1.50, 1.45,  # 08..15
        1.10, 0.85, 0.60, 0.45, 0.35, 0.30, 0.25, 0.18,  # 16..23
    ]
    PROFIL_JOURS = [1.0, 1.08, 1.10, 1.05, 1.02, 0.55, 0.42]  # lun..dim

    def __init__(self, rng: random.Random):
        self.rng = rng
        fin = GEN3IA_ANCRAGE
        debut = fin - timedelta(days=30 * FENETRE_MOIS)
        self.debut = debut
        self.fin = fin
        # Poids par jour : récence croissante × rythme hebdomadaire.
        self._jours: List[Tuple[datetime, float]] = []
        nb_jours = (fin - debut).days
        for i in range(nb_jours):
            jour = debut + timedelta(days=i)
            recence = 0.65 + 0.85 * (i / max(1, nb_jours - 1))
            semaine = self.PROFIL_JOURS[jour.weekday()]
            self._jours.append((jour, recence * semaine))
        self._poids = [p for _, p in self._jours]

    def horodatage(self) -> Tuple[datetime, str]:
        """Tire un instant pondéré. Retourne (datetime, iso8601)."""
        jour = self.rng.choices(self._jours, weights=self._poids, k=1)[0][0]
        heure = self.rng.choices(range(24), weights=self.PROFIL_HEURES, k=1)[0]
        minute = self.rng.randrange(60)
        seconde = self.rng.randrange(60)
        instant = jour.replace(hour=heure, minute=minute, second=seconde)
        # Jamais dans le futur par rapport à l'ancrage.
        if instant > self.fin:
            instant = self.fin - timedelta(
                minutes=self.rng.randrange(1, 720)
            )
        return instant, instant.strftime("%Y-%m-%dT%H:%M:%SZ")

    @staticmethod
    def semaine_iso(instant: datetime) -> str:
        annee, semaine, _ = instant.isocalendar()
        return f"{annee}-W{semaine:02d}"


# ─────────────────────────────────────────────────────────────────────────────
# Qualité / difficulté / provenance
# ─────────────────────────────────────────────────────────────────────────────

DIFFICULTES = [
    ("debutant", 0.20),
    ("intermediaire", 0.40),
    ("avance", 0.30),
    ("expert", 0.10),
]

PROVENANCES = [
    ("atelier_gen3ia", 0.35),
    ("expert_metier", 0.30),
    ("communaute_curatee", 0.25),
    ("synthese_controlee", 0.10),
]

BASE_QUALITE = {
    "debutant": 0.88,
    "intermediaire": 0.86,
    "avance": 0.84,
    "expert": 0.82,
}
BONUS_PROVENANCE = {
    "atelier_gen3ia": 0.04,
    "expert_metier": 0.05,
    "communaute_curatee": 0.02,
    "synthese_controlee": 0.01,
}


def tirer_pondere(rng: random.Random, table) -> str:
    """Tire une clé selon des poids [(clé, poids), ...]."""
    cles = [c for c, _ in table]
    poids = [p for _, p in table]
    return rng.choices(cles, weights=poids, k=1)[0]


def score_qualite(rng: random.Random, difficulte: str, provenance: str) -> float:
    base = BASE_QUALITE[difficulte] + BONUS_PROVENANCE[provenance]
    return round(min(0.99, max(0.70, base + rng.uniform(-0.05, 0.05))), 2)


# ─────────────────────────────────────────────────────────────────────────────
# Déduplication
# ─────────────────────────────────────────────────────────────────────────────

def hacher_contenu(instruction: str, output: str) -> str:
    """Hachage stable (sha1) du contenu normalisé — champ dedup_hash."""
    normalise = " ".join(f"{instruction}\n{output}".lower().split())
    return "sha1:" + hashlib.sha1(normalise.encode("utf-8")).hexdigest()[:24]


# ─────────────────────────────────────────────────────────────────────────────
# Contrat d'un domaine
# ─────────────────────────────────────────────────────────────────────────────

# Un builder de tâche reçoit (rng, lang, contexte) et retourne :
#   { "instruction", "input", "output", "task_type", "safety_label",
#     champs spécifiques du domaine... }
# `contexte` porte : difficulte, provenance, instant (datetime), iso, semaine,
# indice global, qualite.
BuilderTache = Callable[[random.Random, str, dict], dict]


@dataclass
class SpecDomaine:
    """Définition complète d'un domaine du corpus Gen3ia."""

    id: str                      # ex. "generation_images"
    nom_fr: str
    nom_en: str
    description_fr: str
    description_en: str
    mots_cles: List[str]         # mots-clés de routage (fr+en, sans accents)
    # [(task_type, poids, builder_fr, builder_en)]
    taches: List[Tuple[str, float, BuilderTache, BuilderTache]] = field(
        default_factory=list
    )
    # Étiquette de sécurité par défaut (surchargeable par tâche).
    safety_label: str = "sans_objet"

    def taches_actives(self) -> List[str]:
        return [t[0] for t in self.taches]


# ─────────────────────────────────────────────────────────────────────────────
# Aides de rédaction bilingue
# ─────────────────────────────────────────────────────────────────────────────

def choisir(rng: random.Random, options):
    return rng.choice(options)


def melanger_variantes(rng: random.Random, variantes_fr, variantes_en):
    """Choisit le MÊME indice de variante dans les deux langues (alignement
    sémantique FR/EN des gabarits)."""
    i = rng.randrange(len(variantes_fr))
    return variantes_fr[i], variantes_en[i]


def lister(elements: List[str], langue: str) -> str:
    """Joint une liste à la française / à l'anglaise."""
    if len(elements) <= 1:
        return elements[0] if elements else ""
    if langue == "fr":
        return ", ".join(elements[:-1]) + " et " + elements[-1]
    return ", ".join(elements[:-1]) + " and " + elements[-1]


def pas_vide(texte: str) -> str:
    return texte.strip() if isinstance(texte, str) else ""
