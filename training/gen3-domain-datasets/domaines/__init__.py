"""Les 18 domaines du corpus Gen3ia (bilingue FR/EN)."""

from .base import SpecDomaine
from .medias import DOMAINES_MEDIAS
from .ingenierie import DOMAINES_INGENIERIE
from .savoir import DOMAINES_SAVOIR
from .business import DOMAINES_BUSINESS

# Ordre canonique des 18 domaines (thèmes demandés par l'utilisateur).
DOMAINES_GEN3IA = [
    *DOMAINES_MEDIAS,        # génération d'images, vidéo, son, clips musicaux
    *DOMAINES_INGENIERIE,    # développement web, test, machines, cyber, hacker
    *DOMAINES_SAVOIR,        # rédaction, sciences humaines, recherche, web
    *DOMAINES_BUSINESS,      # multimodal, vente, santé, données, conseiller
]

assert len(DOMAINES_GEN3IA) == 18, (
    f"18 domaines attendus, {len(DOMAINES_GEN3IA)} définis"
)
ids = [d.id for d in DOMAINES_GEN3IA]
assert len(set(ids)) == 18, f"Identifiants de domaine en doublon : {ids}"

__all__ = ["DOMAINES_GEN3IA", "SpecDomaine"]
