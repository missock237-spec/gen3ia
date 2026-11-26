# GEN3IA LIVE — RAPPORT DE VALIDATION LOT 1 + PHASE 3 (2026-11-26)

**Commits identifiés** : `7e02838` (Phase 0+1) · `ab33a7d`→`a1e0e79` (Phase 2 + fix) · `749322a` (audit post-95c1dc3) · `09c4f1f`→`0460460` (Phase 3 vision) · `500f171`→`384c4ee` (pont + type) — tous poussés sur `main`.
**Preuves** : `50/50 tests verts` (`vitest run lib/live/` : core 11, transport 7, vision 9, décideur 11, gateway 4, security 3, decision-lock 5) + `npx tsc --noEmit` propre sur `lib/live`.

## Terminé et testé (preuves d'exécution, pas « fichiers ajoutés »)

| Phase | Livraison | Preuve test |
|---|---|---|
| 0 — audit | `docs/live/GEN3IA_LIVE_EXISTING_AUDIT.md` : 5 niveaux, 5200 lignes cartographiées, mise à jour après retrait du canal externe (95c1dc3 : cerveau unique conforme à la mission, vocal externe supprimé) | lecture fichier par fichier |
| 1 — Live Engine | `lib/live/core/` : store injectable (mémoire/Firestore), event-bus (historique commun filtré), session-manager (créer/démarrer/pause/reprendre/arrêter/join/leave/pouls/expiration/reprise), state-manager (présence + verrous TTL), live-engine (5 modes indépendants, permissions du modèle zod existant) | 11 tests : cycle de vie, autorisations, expiration, modes indépendants, verrou écran, multi-rôles, bus filtré, abonné défaillant, ré-joinable |
| 2 — transport | `lib/live/transport/` : webrtc-signal (garde fraîcheur 30 s), webrtc-manager (fabrique peer injectée, offre, ICE relayés, adaptation débit, restart ICE borné → échec explicite), sfu-adapter (direct ≤3 viewers, SFU documenté au-delà) | 7 tests avec peer factice |
| 3 — vision réelle | `lib/live/vision/` : frame-selector (dHash + diff pixel exacte, dédup, seuil 2 %), scene-analyzer (bandes texte/colonnes/thème calibrés sur mesures), temporal-analyzer (zones 3×3, déplacement horizontal MESURÉ), ocr-engine (indisponible avec raison — service externe interdit), vision-engine (pipeline complet, réutilise comprehension-multimodale) + **PONT intégré** : vision-decider passe chaque frame au moteur vision (payload `visionPixels`, perception `visual-structural`) | 9 tests sur JPEG RÉELS générés par sharp : dédup, changement, bandes texte, thème sombre, déplacement, OCR non-fabriqué, pipeline engine |

## Limitations restantes (honnêteté — règle de livraison mission)

1. **Phase 4 (vocal bidirectionnel)** : reconstruire 100 % interne (le canal externe a été retiré par 95c1dc3) — ASR/TTS internes ou Web Speech API côté client ; aucune voix n'existe aujourd'hui côté navigateur.
2. **Phase 5 (vidéo caméra)** : la capture existe (getUserMedia avant/arrière via live-interne-panel), l'analyse des frames caméra utilisera le même vision-engine — branchement à faire.
3. **OCR réel** : aucun moteur local dans le dépôt (aucun .onnx embarqué) ; OCR déclaré indisponible avec raison — jamais fabriqué. Ajouter une dépendance locale (tesseract-wasm empaqueté) si accepté.
4. **WebRTC réel** : modules prêts et testés avec peer factice ; validation sur matériel réel (2 navigateurs + TURN) = Phase 13, BLOCKED en sandbox Node.
5. **Scénarios A-L sur matériel** (Phase 13) et production/rollback (Phase 14) : à exécuter sur environnement réel.
6. Le build de production complet n'a pas été validé dans la fenêtre du tour (récursif : voir rapport WEBGPU précédent).
