# Cerveau Gen3 CPU ondulatoire — première base expérimentale

## But

Ce module crée une première architecture cognitive locale fondée sur le système RPIA existant. Il n'emploie pas de LLM distant et exécute ses calculs en TypeScript/JavaScript sur CPU.

Il relie cinq éléments :
1. un encodeur déterministe texte → cible ondulatoire ;
2. une couche RPIA entraînée séparément pour chaque association ;
3. une mémoire associative bornée ;
4. un hippocampe de dix tours pour le contexte immédiat ;
5. un graphe synaptique clairsemé avec plasticité additive bornée et propagation événementielle depuis les unités actives.

## API minimale

```ts
import { CerveauOndulatoireGen3 } from "@/lib/neural/brain/cerveau-ondulatoire";

const cerveau = new CerveauOndulatoireGen3({
  taille: 64,
  budgetActif: 8,
  capaciteMemoire: 512,
});

const apprentissage = cerveau.apprendre(
  "Capitale du Cameroun",
  "Yaoundé",
);

const resultat = cerveau.percevoir("Capitale du Cameroun");
// resultat.sortie === "Yaoundé" après apprentissage exact.

const checkpoint = cerveau.exporterEtat();
// Persister checkpoint dans le stockage choisi par l'application.

cerveau.importerEtat(checkpoint);
```

## Garanties de cette étape

- Aucune dépendance GPU, modèle distant, API externe ou accès réseau.
- Graine déterministe pour l'initialisation des oscillateurs.
- Nombre d'unités actives borné par étage par `budgetActif`.
- La propagation parcourt uniquement les synapses sortantes des unités actives.
- Mémoire associative plafonnée et hippocampe limité à dix tours.
- Checkpoints exportables en JSON et validation avant restauration.
- Rappel exact normalisé par défaut (seuil 1.0) ; le rappel approximatif doit être activé explicitement et évalué ; les réponses inconnues restent `null` plutôt que d'être inventées.
- Métriques de base disponibles pour compter associations, synapses, unités actives et comparaisons.

## Limites à ne pas masquer

Le conditionneur texte actuel dérive son vecteur d'un hachage déterministe. Ce n'est pas une représentation sémantique entraînée : deux phrases différentes ne sont pas garanties proches, et une similarité vectorielle ne prouve pas qu'elles signifient la même chose. Le seuil de rappel doit rester conservateur jusqu'à l'implémentation d'un encodeur appris et l'évaluation des faux rappels.

Ce module apprend des associations et réutilise des états RPIA ; il ne génère pas encore du langage libre, ne comprend pas toutes les connaissances générales et ne constitue pas un cerveau biologique. Il s'agit d'un noyau expérimental qu'il faut évaluer avant de le raccorder au runtime de conversation de production.

## Étapes techniques suivantes

1. Ajouter des jeux de tests pour rappel exact, faux rappels, oubli, persistance et stabilité RPIA.
2. Construire un benchmark reproductible CPU mesurant mémoire maximale, durée, nombre de synapses visitées et qualité sur données tenues à l'écart.
3. Remplacer l'empreinte de hachage par un encodeur appris sur données, avec une vraie mesure de généralisation.
4. Concevoir la consolidation de mémoire et les mécanismes anti-oubli avant d'autoriser un apprentissage continu.
5. Intégrer progressivement ce noyau au runtime existant après validation, sans basculer automatiquement le trafic de production.
