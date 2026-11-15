# Cerveau Gen3 CPU ondulatoire — première base expérimentale

## But

Ce module crée une première architecture cognitive locale fondée sur le système RPIA existant. Il n'emploie pas de LLM distant et exécute ses calculs en TypeScript/JavaScript sur CPU.

Il relie cinq éléments :
1. un encodeur lexical déterministe texte → vecteur ondulatoire, combinant mots, paires de mots et trigrammes de caractères ;
2. un cortex RPIA partagé qui apprend progressivement à partir de plusieurs expériences et sauvegarde une trace ondulatoire épisodique par souvenir ;
3. une mémoire associative bornée ;
4. un hippocampe de dix tours pour le contexte immédiat ;
5. un graphe synaptique clairsemé avec plasticité additive bornée et propagation événementielle depuis les unités actives ;
6. un mécanisme de rejeu hippocampique qui consolide les associations récentes sans effacer la mémoire de travail.

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
- Mémoire associative plafonnée, budget taille × souvenirs limité à un million de cellules et budget textuel cumulé limité à vingt millions de caractères ; hippocampe limité à dix tours.
- Checkpoints JSON version 2 comprenant le cortex RPIA partagé, sa configuration et les mémoires ; validation avant restauration.
- Rejeu hippocampique contrôlé qui renforce les associations déjà apprises sans inventer de réponse.
- Rappel exact normalisé par défaut (seuil 1.0) ; le rappel approximatif doit être activé explicitement et évalué ; les réponses inconnues restent `null` plutôt que d'être inventées.
- Métriques de base disponibles pour compter associations, synapses, unités actives et comparaisons.

## Limites à ne pas masquer

L'encodeur lexical actuel projette par hachage signé les mots, paires de mots et trigrammes de caractères. Il capture un recouvrement lexical/morphologique de base, mais ce n'est pas une représentation sémantique entraînée : il ne comprend pas de façon fiable la négation, la paraphrase ou le contexte. Une similarité cosinus n'est pas une probabilité calibrée. Le rappel approximatif doit être activé et évalué explicitement avec un seuil prudent.

Ce module apprend des associations et réutilise des états RPIA ; il ne génère pas encore du langage libre, ne comprend pas toutes les connaissances générales et ne constitue pas un cerveau biologique. Il s'agit d'un noyau expérimental qu'il faut évaluer avant de le raccorder au runtime de conversation de production.

## Validation et étapes techniques suivantes

Le banc d'essai initial est disponible via `npm run benchmark:brain` et s'exécute aussi dans la CI. Il contrôle un petit ensemble d'associations connues, trois variantes lexicales et trois requêtes étrangères au jeu d'apprentissage. Ce test est un garde-fou de régression, pas une mesure de performance générale.

1. Exécuter la CI et examiner les résultats du benchmark CPU et des tests de sécurité.
2. Agrandir l'évaluation avec plusieurs tailles, graines, longueurs de texte et jeux de test séparés ; mesurer faux rappels, oubli, persistance, mémoire et latence.
3. Apprendre une représentation sémantique à partir de données plutôt que supposer qu'une empreinte lexicale comprend le sens.
4. Ajouter des mécanismes d'anti-oubli et une persistance durable isolée par compte/utilisateur.
5. Intégrer progressivement ce noyau au runtime existant après validation, sans basculer automatiquement le trafic de production.
