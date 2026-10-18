"""Worker GPU d'entraînement Gen3ia — service Python autonome (FastAPI).

Ce package implémente le contrat consommé par la plateforme Next.js côté
`lib/training/providers/worker-http.ts` :

- ``GET  /healthz``                  : sonde de vie (sans authentification) ;
- ``GET  /capabilities``             : GPU réels détectés via ``torch.cuda`` ;
- ``POST /jobs``                     : soumission d'une tâche d'entraînement ;
- ``GET  /jobs/{externalId}``        : état complet (progression, journaux…) ;
- ``POST /jobs/{externalId}/cancel`` : annulation (échec au prochain contrôle).

Règle d'honnêteté du studio (docs/training-studio.md §1) : **aucune simulation
d'entraînement en production**. Le moteur ``fake`` n'est accepté que lorsque
``WORKER_ALLOW_FAKE_ENGINE=true`` (réservé aux tests). Le CPU est déclaré
honnêtement dans les capacités : il ne permet d'exécuter que ``rag-index``.

Toutes les dépendances lourdes (torch, transformers, peft, sentence-transformers,
boto3) sont importées **paresseusement** : importer ce package ne doit jamais
exiger leur installation — les tests tournent donc sans GPU ni boto3.
"""

__version__ = "1.0.0"
