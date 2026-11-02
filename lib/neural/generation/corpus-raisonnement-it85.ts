/**
 * CORPUS RAISONNEMENT HUMAIN it.85 — dérivé du générateur déterministe
 * (lib/gen3/raisonnement-humain.ts, 16 familles de raisonnement humain,
 * 1 000 000 paires PP assimilées par ONDES au cortex 1M —
 * scripts/entrainement-raisonnement-humain-it85.ts, bande-porteuse
 * 0 « raisonnement-humain-fr », seed 42).
 *
 * Ces 192 paires PP (Prompt → Pensée pas à pas → Réponse) sont
 * réparties sur les seize familles (déduction, conditionnel, induction,
 * abduction, analogie, causalité, sens commun, théorie de l'esprit,
 * planification, mathématique verbale, pragmatique, éthique pratique,
 * spatial, temporel, métacognition, résolution de problème) et servent
 * le raisonnement du chat comme code source (module PUR — aucune
 * dépendance Node).
 */

import type { PaireLangage } from "./corpus";

export const CORPUS_RAISONNEMENT_IT85: readonly PaireLangage[] = [
  {
    motif: "Tous les oiseaux sont des animaux. Alice fait partie des oiseaux. Qu'est-ce qu'on peut en déduire ?",
    reponse: "1) On raisonne par déduction : si les prémisses sont vraies, la conclusion est certaine. 2) Première prémisse : tous les oiseaux sont des animaux. 3) Deuxième prémisse : Alice fait partie des oiseaux. 4) Ce qui vaut pour tous les oiseaux vaut donc aussi pour Alice. Donc : On peut en déduire que Alice, comme tous les oiseaux, appartient aussi aux animaux.",
    theme: "deduction",
  },
  {
    motif: "Exercice de logique : Attention, question piège : tous les oiseaux sont des animaux. On annonce que Alice fait partie des animaux. Peut-on conclure que Alice fait partie des oiseaux ?",
    reponse: "1) On vérifie d'abord si l'inférence est légale : dans quel sens va-t-elle ? 2) La règle dit : tous les oiseaux sont des animaux — le sens oiseaux → animaux. 3) La question demande le chemin inverse : animaux → oiseaux. Ce n'est pas la même chose. 4) Conclure l'inverse serait le sophisme de la converse : tous les A sont des B n'implique pas que tous les B soient des A. 5) Rien ne dit que Alice soit un oiseaux : il peut appartenir à une autre partie des animaux. Donc : Non : on ne peut pas conclure que Alice fait partie des oiseaux. C'est l'erreur classique d'inverser un syllogisme.",
    theme: "deduction",
  },
  {
    motif: "On sait que tous les oiseaux sont des animaux, et que Alice fait partie des oiseaux. Que concluez-vous ?",
    reponse: "1) On raisonne par déduction : si les prémisses sont vraies, la conclusion est certaine. 2) Première prémisse : tous les oiseaux sont des animaux. 3) Deuxième prémisse : Alice fait partie des oiseaux. 4) Ce qui vaut pour tous les oiseaux vaut donc aussi pour Alice. Donc : On peut en déduire que Alice, comme tous les oiseaux, appartient aussi aux animaux.",
    theme: "deduction",
  },
  {
    motif: "Raisonnons : Attention, question piège : tous les oiseaux sont des animaux. On annonce que Alice fait partie des animaux. Peut-on conclure que Alice fait partie des oiseaux ?",
    reponse: "1) On vérifie d'abord si l'inférence est légale : dans quel sens va-t-elle ? 2) La règle dit : tous les oiseaux sont des animaux — le sens oiseaux → animaux. 3) La question demande le chemin inverse : animaux → oiseaux. Ce n'est pas la même chose. 4) Conclure l'inverse serait le sophisme de la converse : tous les A sont des B n'implique pas que tous les B soient des A. 5) Rien ne dit que Alice soit un oiseaux : il peut appartenir à une autre partie des animaux. Donc : Non : on ne peut pas conclure que Alice fait partie des oiseaux. C'est l'erreur classique d'inverser un syllogisme.",
    theme: "deduction",
  },
  {
    motif: "Si quelque chose fait partie des oiseaux, alors elle fait partie des animaux. Alice fait partie des oiseaux. Qu'en déduit-on ?",
    reponse: "1) On raisonne par déduction : si les prémisses sont vraies, la conclusion est certaine. 2) Première prémisse : tous les oiseaux sont des animaux. 3) Deuxième prémisse : Alice fait partie des oiseaux. 4) Ce qui vaut pour tous les oiseaux vaut donc aussi pour Alice. Donc : On peut en déduire que Alice, comme tous les oiseaux, appartient aussi aux animaux.",
    theme: "deduction",
  },
  {
    motif: "Petit test de logique : Attention, question piège : tous les oiseaux sont des animaux. On annonce que Alice fait partie des animaux. Peut-on conclure que Alice fait partie des oiseaux ?",
    reponse: "1) On vérifie d'abord si l'inférence est légale : dans quel sens va-t-elle ? 2) La règle dit : tous les oiseaux sont des animaux — le sens oiseaux → animaux. 3) La question demande le chemin inverse : animaux → oiseaux. Ce n'est pas la même chose. 4) Conclure l'inverse serait le sophisme de la converse : tous les A sont des B n'implique pas que tous les B soient des A. 5) Rien ne dit que Alice soit un oiseaux : il peut appartenir à une autre partie des animaux. Donc : Non : on ne peut pas conclure que Alice fait partie des oiseaux. C'est l'erreur classique d'inverser un syllogisme.",
    theme: "deduction",
  },
  {
    motif: "Voici deux affirmations : « tous les oiseaux sont des animaux » et « Alice fait partie des oiseaux ». Qu'en suit-il ?",
    reponse: "1) On raisonne par déduction : si les prémisses sont vraies, la conclusion est certaine. 2) Première prémisse : tous les oiseaux sont des animaux. 3) Deuxième prémisse : Alice fait partie des oiseaux. 4) Ce qui vaut pour tous les oiseaux vaut donc aussi pour Alice. Donc : On peut en déduire que Alice, comme tous les oiseaux, appartient aussi aux animaux.",
    theme: "deduction",
  },
  {
    motif: "Voici une règle : Attention, question piège : tous les oiseaux sont des animaux. On annonce que Alice fait partie des animaux. Peut-on conclure que Alice fait partie des oiseaux ?",
    reponse: "1) On vérifie d'abord si l'inférence est légale : dans quel sens va-t-elle ? 2) La règle dit : tous les oiseaux sont des animaux — le sens oiseaux → animaux. 3) La question demande le chemin inverse : animaux → oiseaux. Ce n'est pas la même chose. 4) Conclure l'inverse serait le sophisme de la converse : tous les A sont des B n'implique pas que tous les B soient des A. 5) Rien ne dit que Alice soit un oiseaux : il peut appartenir à une autre partie des animaux. Donc : Non : on ne peut pas conclure que Alice fait partie des oiseaux. C'est l'erreur classique d'inverser un syllogisme.",
    theme: "deduction",
  },
  {
    motif: "Exercice de logique : tous les oiseaux sont des animaux ; Alice est du nombre des oiseaux. Quelle est la conclusion ?",
    reponse: "1) On raisonne par déduction : si les prémisses sont vraies, la conclusion est certaine. 2) Première prémisse : tous les oiseaux sont des animaux. 3) Deuxième prémisse : Alice fait partie des oiseaux. 4) Ce qui vaut pour tous les oiseaux vaut donc aussi pour Alice. Donc : On peut en déduire que Alice, comme tous les oiseaux, appartient aussi aux animaux.",
    theme: "deduction",
  },
  {
    motif: "Vérifions ce qu'on peut conclure : Attention, question piège : tous les oiseaux sont des animaux. On annonce que Alice fait partie des animaux. Peut-on conclure que Alice fait partie des oiseaux ?",
    reponse: "1) On vérifie d'abord si l'inférence est légale : dans quel sens va-t-elle ? 2) La règle dit : tous les oiseaux sont des animaux — le sens oiseaux → animaux. 3) La question demande le chemin inverse : animaux → oiseaux. Ce n'est pas la même chose. 4) Conclure l'inverse serait le sophisme de la converse : tous les A sont des B n'implique pas que tous les B soient des A. 5) Rien ne dit que Alice soit un oiseaux : il peut appartenir à une autre partie des animaux. Donc : Non : on ne peut pas conclure que Alice fait partie des oiseaux. C'est l'erreur classique d'inverser un syllogisme.",
    theme: "deduction",
  },
  {
    motif: "Raisonnons : toute chose du groupe des oiseaux appartient au groupe des animaux. Alice appartient au groupe des oiseaux. Conclusion ?",
    reponse: "1) On raisonne par déduction : si les prémisses sont vraies, la conclusion est certaine. 2) Première prémisse : tous les oiseaux sont des animaux. 3) Deuxième prémisse : Alice fait partie des oiseaux. 4) Ce qui vaut pour tous les oiseaux vaut donc aussi pour Alice. Donc : On peut en déduire que Alice, comme tous les oiseaux, appartient aussi aux animaux.",
    theme: "deduction",
  },
  {
    motif: "Attention, question piège : tous les oiseaux sont des animaux. On annonce que Alice fait partie des animaux. Peut-on conclure que Alice fait partie des oiseaux ?",
    reponse: "1) On vérifie d'abord si l'inférence est légale : dans quel sens va-t-elle ? 2) La règle dit : tous les oiseaux sont des animaux — le sens oiseaux → animaux. 3) La question demande le chemin inverse : animaux → oiseaux. Ce n'est pas la même chose. 4) Conclure l'inverse serait le sophisme de la converse : tous les A sont des B n'implique pas que tous les B soient des A. 5) Rien ne dit que Alice soit un oiseaux : il peut appartenir à une autre partie des animaux. Donc : Non : on ne peut pas conclure que Alice fait partie des oiseaux. C'est l'erreur classique d'inverser un syllogisme.",
    theme: "deduction",
  },
  {
    motif: "Exercice de logique : Si on chauffe de l'eau à 100 °C, alors elle se met à bouillir. Or, on observe que on chauffe de l'eau à 100 °C. Qu'en déduit-on ?",
    reponse: "1) On raisonne par modus ponens : la condition est remplie, la conséquence suit. 2) Règle : si on chauffe de l'eau à 100 °C, alors elle se met à bouillir. 3) Observation : on chauffe de l'eau à 100 °C — la condition est remplie. 4) On applique la règle telle quelle. Donc : On en déduit que elle se met à bouillir.",
    theme: "conditionnel",
  },
  {
    motif: "Raisonnons : Si on chauffe de l'eau à 100 °C, alors elle se met à bouillir. Or, on observe que on chauffe de l'eau à 100 °C. Qu'en déduit-on ?",
    reponse: "1) On raisonne par modus ponens : la condition est remplie, la conséquence suit. 2) Règle : si on chauffe de l'eau à 100 °C, alors elle se met à bouillir. 3) Observation : on chauffe de l'eau à 100 °C — la condition est remplie. 4) On applique la règle telle quelle. Donc : On en déduit que elle se met à bouillir.",
    theme: "conditionnel",
  },
  {
    motif: "Petit test de logique : Si on chauffe de l'eau à 100 °C, alors elle se met à bouillir. Or, on observe que on chauffe de l'eau à 100 °C. Qu'en déduit-on ?",
    reponse: "1) On raisonne par modus ponens : la condition est remplie, la conséquence suit. 2) Règle : si on chauffe de l'eau à 100 °C, alors elle se met à bouillir. 3) Observation : on chauffe de l'eau à 100 °C — la condition est remplie. 4) On applique la règle telle quelle. Donc : On en déduit que elle se met à bouillir.",
    theme: "conditionnel",
  },
  {
    motif: "Voici une règle : Si on chauffe de l'eau à 100 °C, alors elle se met à bouillir. Or, on observe que on chauffe de l'eau à 100 °C. Qu'en déduit-on ?",
    reponse: "1) On raisonne par modus ponens : la condition est remplie, la conséquence suit. 2) Règle : si on chauffe de l'eau à 100 °C, alors elle se met à bouillir. 3) Observation : on chauffe de l'eau à 100 °C — la condition est remplie. 4) On applique la règle telle quelle. Donc : On en déduit que elle se met à bouillir.",
    theme: "conditionnel",
  },
  {
    motif: "Vérifions ce qu'on peut conclure : Si on chauffe de l'eau à 100 °C, alors elle se met à bouillir. Or, on observe que on chauffe de l'eau à 100 °C. Qu'en déduit-on ?",
    reponse: "1) On raisonne par modus ponens : la condition est remplie, la conséquence suit. 2) Règle : si on chauffe de l'eau à 100 °C, alors elle se met à bouillir. 3) Observation : on chauffe de l'eau à 100 °C — la condition est remplie. 4) On applique la règle telle quelle. Donc : On en déduit que elle se met à bouillir.",
    theme: "conditionnel",
  },
  {
    motif: "Si on chauffe de l'eau à 100 °C, alors elle se met à bouillir. Or, on observe que on chauffe de l'eau à 100 °C. Qu'en déduit-on ?",
    reponse: "1) On raisonne par modus ponens : la condition est remplie, la conséquence suit. 2) Règle : si on chauffe de l'eau à 100 °C, alors elle se met à bouillir. 3) Observation : on chauffe de l'eau à 100 °C — la condition est remplie. 4) On applique la règle telle quelle. Donc : On en déduit que elle se met à bouillir.",
    theme: "conditionnel",
  },
  {
    motif: "Exercice de logique : Si on chauffe de l'eau à 100 °C, alors elle se met à bouillir. Or, on constate que elle se met à bouillir n'a pas eu lieu. Que peut-on conclure ?",
    reponse: "1) On raisonne par modus tollens : nier la conséquence permet de nier la cause. 2) Règle : si on chauffe de l'eau à 100 °C, alors elle se met à bouillir. 3) Observation : elle se met à bouillir n'a pas eu lieu. 4) Si la cause était présente, la conséquence suivrait — elle ne suit pas, donc la cause n'était pas là. 5) Prudence : si c'était la cause qui manquait sans information sur la conséquence, on ne pourrait rien conclure — nier la cause ne dit rien de la conséquence. Donc : On conclut que on chauffe de l'eau à 100 °C n'a pas eu lieu.",
    theme: "conditionnel",
  },
  {
    motif: "Raisonnons : Si on chauffe de l'eau à 100 °C, alors elle se met à bouillir. Or, on constate que elle se met à bouillir n'a pas eu lieu. Que peut-on conclure ?",
    reponse: "1) On raisonne par modus tollens : nier la conséquence permet de nier la cause. 2) Règle : si on chauffe de l'eau à 100 °C, alors elle se met à bouillir. 3) Observation : elle se met à bouillir n'a pas eu lieu. 4) Si la cause était présente, la conséquence suivrait — elle ne suit pas, donc la cause n'était pas là. 5) Prudence : si c'était la cause qui manquait sans information sur la conséquence, on ne pourrait rien conclure — nier la cause ne dit rien de la conséquence. Donc : On conclut que on chauffe de l'eau à 100 °C n'a pas eu lieu.",
    theme: "conditionnel",
  },
  {
    motif: "Petit test de logique : Si on chauffe de l'eau à 100 °C, alors elle se met à bouillir. Or, on constate que elle se met à bouillir n'a pas eu lieu. Que peut-on conclure ?",
    reponse: "1) On raisonne par modus tollens : nier la conséquence permet de nier la cause. 2) Règle : si on chauffe de l'eau à 100 °C, alors elle se met à bouillir. 3) Observation : elle se met à bouillir n'a pas eu lieu. 4) Si la cause était présente, la conséquence suivrait — elle ne suit pas, donc la cause n'était pas là. 5) Prudence : si c'était la cause qui manquait sans information sur la conséquence, on ne pourrait rien conclure — nier la cause ne dit rien de la conséquence. Donc : On conclut que on chauffe de l'eau à 100 °C n'a pas eu lieu.",
    theme: "conditionnel",
  },
  {
    motif: "Voici une règle : Si on chauffe de l'eau à 100 °C, alors elle se met à bouillir. Or, on constate que elle se met à bouillir n'a pas eu lieu. Que peut-on conclure ?",
    reponse: "1) On raisonne par modus tollens : nier la conséquence permet de nier la cause. 2) Règle : si on chauffe de l'eau à 100 °C, alors elle se met à bouillir. 3) Observation : elle se met à bouillir n'a pas eu lieu. 4) Si la cause était présente, la conséquence suivrait — elle ne suit pas, donc la cause n'était pas là. 5) Prudence : si c'était la cause qui manquait sans information sur la conséquence, on ne pourrait rien conclure — nier la cause ne dit rien de la conséquence. Donc : On conclut que on chauffe de l'eau à 100 °C n'a pas eu lieu.",
    theme: "conditionnel",
  },
  {
    motif: "Vérifions ce qu'on peut conclure : Si on chauffe de l'eau à 100 °C, alors elle se met à bouillir. Or, on constate que elle se met à bouillir n'a pas eu lieu. Que peut-on conclure ?",
    reponse: "1) On raisonne par modus tollens : nier la conséquence permet de nier la cause. 2) Règle : si on chauffe de l'eau à 100 °C, alors elle se met à bouillir. 3) Observation : elle se met à bouillir n'a pas eu lieu. 4) Si la cause était présente, la conséquence suivrait — elle ne suit pas, donc la cause n'était pas là. 5) Prudence : si c'était la cause qui manquait sans information sur la conséquence, on ne pourrait rien conclure — nier la cause ne dit rien de la conséquence. Donc : On conclut que on chauffe de l'eau à 100 °C n'a pas eu lieu.",
    theme: "conditionnel",
  },
  {
    motif: "Si on chauffe de l'eau à 100 °C, alors elle se met à bouillir. Or, on constate que elle se met à bouillir n'a pas eu lieu. Que peut-on conclure ?",
    reponse: "1) On raisonne par modus tollens : nier la conséquence permet de nier la cause. 2) Règle : si on chauffe de l'eau à 100 °C, alors elle se met à bouillir. 3) Observation : elle se met à bouillir n'a pas eu lieu. 4) Si la cause était présente, la conséquence suivrait — elle ne suit pas, donc la cause n'était pas là. 5) Prudence : si c'était la cause qui manquait sans information sur la conséquence, on ne pourrait rien conclure — nier la cause ne dit rien de la conséquence. Donc : On conclut que on chauffe de l'eau à 100 °C n'a pas eu lieu.",
    theme: "conditionnel",
  },
  {
    motif: "On a observé trois fois : le soleil s'est levé à l'est chaque matin de la semaine. Peut-on en conclure que demain encore, il se lèvera à l'est ? Avec quelle prudence ?",
    reponse: "1) On raisonne par induction : on généralise à partir d'observations répétées. 2) On a observé trois fois : le soleil s'est levé à l'est chaque matin de la semaine. 3) Le motif est régulier, mais aucune règle ne garantit la suite — une induction ne fait pas loi. 4) La prudence humaine : conclure « probablement », jamais « certainement ». Donc : Il est raisonnable de conclure que demain encore, il se lèvera à l'est — c'est une induction probable, pas une certitude.",
    theme: "induction",
  },
  {
    motif: "Induction : On a observé trois fois : le soleil s'est levé à l'est chaque matin de la semaine. Peut-on en conclure que demain encore, il se lèvera à l'est ?",
    reponse: "1) On raisonne par induction : on généralise à partir d'observations répétées. 2) On a observé trois fois : le soleil s'est levé à l'est chaque matin de la semaine. 3) Le motif est régulier, mais aucune règle ne garantit la suite — une induction ne fait pas loi. 4) La prudence humaine : conclure « probablement », jamais « certainement ». Donc : Il est raisonnable de conclure que demain encore, il se lèvera à l'est — c'est une induction probable, pas une certitude.",
    theme: "induction",
  },
  {
    motif: "On a observé trois fois : le soleil s'est levé à l'est chaque matin de la semaine. Que peut-on raisonnablement conclure ?",
    reponse: "1) On raisonne par induction : on généralise à partir d'observations répétées. 2) On a observé trois fois : le soleil s'est levé à l'est chaque matin de la semaine. 3) Le motif est régulier, mais aucune règle ne garantit la suite — une induction ne fait pas loi. 4) La prudence humaine : conclure « probablement », jamais « certainement ». Donc : Il est raisonnable de conclure que demain encore, il se lèvera à l'est — c'est une induction probable, pas une certitude.",
    theme: "induction",
  },
  {
    motif: "Série d'observations (astronomie quotidienne), trois fois : le soleil s'est levé à l'est chaque matin de la semaine. Peut-on en conclure que demain encore, il se lèvera à l'est ?",
    reponse: "1) On raisonne par induction : on généralise à partir d'observations répétées. 2) On a observé trois fois : le soleil s'est levé à l'est chaque matin de la semaine. 3) Le motif est régulier, mais aucune règle ne garantit la suite — une induction ne fait pas loi. 4) La prudence humaine : conclure « probablement », jamais « certainement ». Donc : Il est raisonnable de conclure que demain encore, il se lèvera à l'est — c'est une induction probable, pas une certitude.",
    theme: "induction",
  },
  {
    motif: "On a observé cinq fois : le soleil s'est levé à l'est chaque matin de la semaine. Peut-on en conclure que demain encore, il se lèvera à l'est ? Avec quelle prudence ?",
    reponse: "1) On raisonne par induction : on généralise à partir d'observations répétées. 2) On a observé cinq fois : le soleil s'est levé à l'est chaque matin de la semaine. 3) Le motif est régulier, mais aucune règle ne garantit la suite — une induction ne fait pas loi. 4) La prudence humaine : conclure « probablement », jamais « certainement ». Donc : Il est raisonnable de conclure que demain encore, il se lèvera à l'est — c'est une induction probable, pas une certitude.",
    theme: "induction",
  },
  {
    motif: "Induction : On a observé cinq fois : le soleil s'est levé à l'est chaque matin de la semaine. Peut-on en conclure que demain encore, il se lèvera à l'est ?",
    reponse: "1) On raisonne par induction : on généralise à partir d'observations répétées. 2) On a observé cinq fois : le soleil s'est levé à l'est chaque matin de la semaine. 3) Le motif est régulier, mais aucune règle ne garantit la suite — une induction ne fait pas loi. 4) La prudence humaine : conclure « probablement », jamais « certainement ». Donc : Il est raisonnable de conclure que demain encore, il se lèvera à l'est — c'est une induction probable, pas une certitude.",
    theme: "induction",
  },
  {
    motif: "On a observé cinq fois : le soleil s'est levé à l'est chaque matin de la semaine. Que peut-on raisonnablement conclure ?",
    reponse: "1) On raisonne par induction : on généralise à partir d'observations répétées. 2) On a observé cinq fois : le soleil s'est levé à l'est chaque matin de la semaine. 3) Le motif est régulier, mais aucune règle ne garantit la suite — une induction ne fait pas loi. 4) La prudence humaine : conclure « probablement », jamais « certainement ». Donc : Il est raisonnable de conclure que demain encore, il se lèvera à l'est — c'est une induction probable, pas une certitude.",
    theme: "induction",
  },
  {
    motif: "Série d'observations (astronomie quotidienne), cinq fois : le soleil s'est levé à l'est chaque matin de la semaine. Peut-on en conclure que demain encore, il se lèvera à l'est ?",
    reponse: "1) On raisonne par induction : on généralise à partir d'observations répétées. 2) On a observé cinq fois : le soleil s'est levé à l'est chaque matin de la semaine. 3) Le motif est régulier, mais aucune règle ne garantit la suite — une induction ne fait pas loi. 4) La prudence humaine : conclure « probablement », jamais « certainement ». Donc : Il est raisonnable de conclure que demain encore, il se lèvera à l'est — c'est une induction probable, pas une certitude.",
    theme: "induction",
  },
  {
    motif: "On a observé dix fois de suite : le soleil s'est levé à l'est chaque matin de la semaine. Peut-on en conclure que demain encore, il se lèvera à l'est ? Avec quelle prudence ?",
    reponse: "1) On raisonne par induction : on généralise à partir d'observations répétées. 2) On a observé dix fois de suite : le soleil s'est levé à l'est chaque matin de la semaine. 3) Le motif est régulier, mais aucune règle ne garantit la suite — une induction ne fait pas loi. 4) La prudence humaine : conclure « probablement », jamais « certainement ». Donc : Il est raisonnable de conclure que demain encore, il se lèvera à l'est — c'est une induction probable, pas une certitude.",
    theme: "induction",
  },
  {
    motif: "Induction : On a observé dix fois de suite : le soleil s'est levé à l'est chaque matin de la semaine. Peut-on en conclure que demain encore, il se lèvera à l'est ?",
    reponse: "1) On raisonne par induction : on généralise à partir d'observations répétées. 2) On a observé dix fois de suite : le soleil s'est levé à l'est chaque matin de la semaine. 3) Le motif est régulier, mais aucune règle ne garantit la suite — une induction ne fait pas loi. 4) La prudence humaine : conclure « probablement », jamais « certainement ». Donc : Il est raisonnable de conclure que demain encore, il se lèvera à l'est — c'est une induction probable, pas une certitude.",
    theme: "induction",
  },
  {
    motif: "On a observé dix fois de suite : le soleil s'est levé à l'est chaque matin de la semaine. Que peut-on raisonnablement conclure ?",
    reponse: "1) On raisonne par induction : on généralise à partir d'observations répétées. 2) On a observé dix fois de suite : le soleil s'est levé à l'est chaque matin de la semaine. 3) Le motif est régulier, mais aucune règle ne garantit la suite — une induction ne fait pas loi. 4) La prudence humaine : conclure « probablement », jamais « certainement ». Donc : Il est raisonnable de conclure que demain encore, il se lèvera à l'est — c'est une induction probable, pas une certitude.",
    theme: "induction",
  },
  {
    motif: "Série d'observations (astronomie quotidienne), dix fois de suite : le soleil s'est levé à l'est chaque matin de la semaine. Peut-on en conclure que demain encore, il se lèvera à l'est ?",
    reponse: "1) On raisonne par induction : on généralise à partir d'observations répétées. 2) On a observé dix fois de suite : le soleil s'est levé à l'est chaque matin de la semaine. 3) Le motif est régulier, mais aucune règle ne garantit la suite — une induction ne fait pas loi. 4) La prudence humaine : conclure « probablement », jamais « certainement ». Donc : Il est raisonnable de conclure que demain encore, il se lèvera à l'est — c'est une induction probable, pas une certitude.",
    theme: "induction",
  },
  {
    motif: "Voici un fait étrange : le sol du jardin est mouillé au réveil alors qu'il n'a pas plu selon la météo. Quelle est l'explication la plus plausible ?",
    reponse: "1) On raisonne par abduction : chercher la meilleure explication d'un fait surprenant. 2) Fait : le sol du jardin est mouillé au réveil alors qu'il n'a pas plu selon la météo. 3) Hypothèses possibles : l'arroseur automatique a tourné pendant la nuit ; une fuite du tuyau d'arrosage ; de la rosée abondante. 4) La plus plausible : l'arroseur automatique a tourné pendant la nuit — elle explique le fait avec le moins de suppositions. 5) Comment la vérifier : regarder la programmation de l'arroseur. Donc : L'explication la plus probable est que l'arroseur automatique a tourné pendant la nuit ; pour en être sûr : regarder la programmation de l'arroseur.",
    theme: "abduction",
  },
  {
    motif: "D'où cela peut-il bien venir ? le sol du jardin est mouillé au réveil alors qu'il n'a pas plu selon la météo — donnez la meilleure hypothèse.",
    reponse: "1) On raisonne par abduction : chercher la meilleure explication d'un fait surprenant. 2) Fait : le sol du jardin est mouillé au réveil alors qu'il n'a pas plu selon la météo. 3) Hypothèses possibles : l'arroseur automatique a tourné pendant la nuit ; une fuite du tuyau d'arrosage ; de la rosée abondante. 4) La plus plausible : l'arroseur automatique a tourné pendant la nuit — elle explique le fait avec le moins de suppositions. 5) Comment la vérifier : regarder la programmation de l'arroseur. Donc : L'explication la plus probable est que l'arroseur automatique a tourné pendant la nuit ; pour en être sûr : regarder la programmation de l'arroseur.",
    theme: "abduction",
  },
  {
    motif: "Enquête : le sol du jardin est mouillé au réveil alors qu'il n'a pas plu selon la météo. Quelle est l'hypothèse la plus probable, et comment la vérifier ?",
    reponse: "1) On raisonne par abduction : chercher la meilleure explication d'un fait surprenant. 2) Fait : le sol du jardin est mouillé au réveil alors qu'il n'a pas plu selon la météo. 3) Hypothèses possibles : l'arroseur automatique a tourné pendant la nuit ; une fuite du tuyau d'arrosage ; de la rosée abondante. 4) La plus plausible : l'arroseur automatique a tourné pendant la nuit — elle explique le fait avec le moins de suppositions. 5) Comment la vérifier : regarder la programmation de l'arroseur. Donc : L'explication la plus probable est que l'arroseur automatique a tourné pendant la nuit ; pour en être sûr : regarder la programmation de l'arroseur.",
    theme: "abduction",
  },
  {
    motif: "On constate que le sol du jardin est mouillé au réveil alors qu'il n'a pas plu selon la météo. Raisonnez comme un détective : quelle est l'explication la plus simple ?",
    reponse: "1) On raisonne par abduction : chercher la meilleure explication d'un fait surprenant. 2) Fait : le sol du jardin est mouillé au réveil alors qu'il n'a pas plu selon la météo. 3) Hypothèses possibles : l'arroseur automatique a tourné pendant la nuit ; une fuite du tuyau d'arrosage ; de la rosée abondante. 4) La plus plausible : l'arroseur automatique a tourné pendant la nuit — elle explique le fait avec le moins de suppositions. 5) Comment la vérifier : regarder la programmation de l'arroseur. Donc : L'explication la plus probable est que l'arroseur automatique a tourné pendant la nuit ; pour en être sûr : regarder la programmation de l'arroseur.",
    theme: "abduction",
  },
  {
    motif: "Voici un fait étrange : la voiture ne démarre plus ce matin. Quelle est l'explication la plus plausible ?",
    reponse: "1) On raisonne par abduction : chercher la meilleure explication d'un fait surprenant. 2) Fait : la voiture ne démarre plus ce matin. 3) Hypothèses possibles : la batterie est à plat ; il n'y a plus de carburant ; le démarreur est cassé. 4) La plus plausible : la batterie est à plat — elle explique le fait avec le moins de suppositions. 5) Comment la vérifier : allumer les phares : s'ils sont faibles, c'est la batterie. Donc : L'explication la plus probable est que la batterie est à plat ; pour en être sûr : allumer les phares : s'ils sont faibles, c'est la batterie.",
    theme: "abduction",
  },
  {
    motif: "D'où cela peut-il bien venir ? la voiture ne démarre plus ce matin — donnez la meilleure hypothèse.",
    reponse: "1) On raisonne par abduction : chercher la meilleure explication d'un fait surprenant. 2) Fait : la voiture ne démarre plus ce matin. 3) Hypothèses possibles : la batterie est à plat ; il n'y a plus de carburant ; le démarreur est cassé. 4) La plus plausible : la batterie est à plat — elle explique le fait avec le moins de suppositions. 5) Comment la vérifier : allumer les phares : s'ils sont faibles, c'est la batterie. Donc : L'explication la plus probable est que la batterie est à plat ; pour en être sûr : allumer les phares : s'ils sont faibles, c'est la batterie.",
    theme: "abduction",
  },
  {
    motif: "Enquête : la voiture ne démarre plus ce matin. Quelle est l'hypothèse la plus probable, et comment la vérifier ?",
    reponse: "1) On raisonne par abduction : chercher la meilleure explication d'un fait surprenant. 2) Fait : la voiture ne démarre plus ce matin. 3) Hypothèses possibles : la batterie est à plat ; il n'y a plus de carburant ; le démarreur est cassé. 4) La plus plausible : la batterie est à plat — elle explique le fait avec le moins de suppositions. 5) Comment la vérifier : allumer les phares : s'ils sont faibles, c'est la batterie. Donc : L'explication la plus probable est que la batterie est à plat ; pour en être sûr : allumer les phares : s'ils sont faibles, c'est la batterie.",
    theme: "abduction",
  },
  {
    motif: "On constate que la voiture ne démarre plus ce matin. Raisonnez comme un détective : quelle est l'explication la plus simple ?",
    reponse: "1) On raisonne par abduction : chercher la meilleure explication d'un fait surprenant. 2) Fait : la voiture ne démarre plus ce matin. 3) Hypothèses possibles : la batterie est à plat ; il n'y a plus de carburant ; le démarreur est cassé. 4) La plus plausible : la batterie est à plat — elle explique le fait avec le moins de suppositions. 5) Comment la vérifier : allumer les phares : s'ils sont faibles, c'est la batterie. Donc : L'explication la plus probable est que la batterie est à plat ; pour en être sûr : allumer les phares : s'ils sont faibles, c'est la batterie.",
    theme: "abduction",
  },
  {
    motif: "Voici un fait étrange : le chat gratte à la porte à 6 h. Quelle est l'explication la plus plausible ?",
    reponse: "1) On raisonne par abduction : chercher la meilleure explication d'un fait surprenant. 2) Fait : le chat gratte à la porte à 6 h. 3) Hypothèses possibles : il a faim ; il veut sortir ; il cherche de la chaleur. 4) La plus plausible : il a faim — elle explique le fait avec le moins de suppositions. 5) Comment la vérifier : le nourrir et voir s'il retourne dormir. Donc : L'explication la plus probable est que il a faim ; pour en être sûr : le nourrir et voir s'il retourne dormir.",
    theme: "abduction",
  },
  {
    motif: "D'où cela peut-il bien venir ? le chat gratte à la porte à 6 h — donnez la meilleure hypothèse.",
    reponse: "1) On raisonne par abduction : chercher la meilleure explication d'un fait surprenant. 2) Fait : le chat gratte à la porte à 6 h. 3) Hypothèses possibles : il a faim ; il veut sortir ; il cherche de la chaleur. 4) La plus plausible : il a faim — elle explique le fait avec le moins de suppositions. 5) Comment la vérifier : le nourrir et voir s'il retourne dormir. Donc : L'explication la plus probable est que il a faim ; pour en être sûr : le nourrir et voir s'il retourne dormir.",
    theme: "abduction",
  },
  {
    motif: "Enquête : le chat gratte à la porte à 6 h. Quelle est l'hypothèse la plus probable, et comment la vérifier ?",
    reponse: "1) On raisonne par abduction : chercher la meilleure explication d'un fait surprenant. 2) Fait : le chat gratte à la porte à 6 h. 3) Hypothèses possibles : il a faim ; il veut sortir ; il cherche de la chaleur. 4) La plus plausible : il a faim — elle explique le fait avec le moins de suppositions. 5) Comment la vérifier : le nourrir et voir s'il retourne dormir. Donc : L'explication la plus probable est que il a faim ; pour en être sûr : le nourrir et voir s'il retourne dormir.",
    theme: "abduction",
  },
  {
    motif: "On constate que le chat gratte à la porte à 6 h. Raisonnez comme un détective : quelle est l'explication la plus simple ?",
    reponse: "1) On raisonne par abduction : chercher la meilleure explication d'un fait surprenant. 2) Fait : le chat gratte à la porte à 6 h. 3) Hypothèses possibles : il a faim ; il veut sortir ; il cherche de la chaleur. 4) La plus plausible : il a faim — elle explique le fait avec le moins de suppositions. 5) Comment la vérifier : le nourrir et voir s'il retourne dormir. Donc : L'explication la plus probable est que il a faim ; pour en être sûr : le nourrir et voir s'il retourne dormir.",
    theme: "abduction",
  },
  {
    motif: "Complétez l'analogie : un doigt est à la main ce que une branche est à quoi ?",
    reponse: "1) On raisonne par analogie : d'abord identifier la relation, ensuite la transférer. 2) Relation entre un doigt et la main : partie → tout. 3) On cherche la contrepartie de une branche qui honore la même relation. 4) Vérification : une branche se rapporte bien à la réponse comme un doigt se rapporte à la main. Donc : La réponse est « l'arbre » : la relation (partie → tout) est la même.",
    theme: "analogie",
  },
  {
    motif: "Complétez l'analogie : une branche est à l'arbre ce que un doigt est à quoi ?",
    reponse: "1) On raisonne par analogie : d'abord identifier la relation, ensuite la transférer. 2) Relation entre une branche et l'arbre : partie → tout. 3) On cherche la contrepartie de un doigt qui honore la même relation. 4) Vérification : un doigt se rapporte bien à la réponse comme une branche se rapporte à l'arbre. Donc : La réponse est « la main » : la relation (partie → tout) est la même.",
    theme: "analogie",
  },
  {
    motif: "« un doigt est à la main comme une branche est à … » — trouvez le mot manquant.",
    reponse: "1) On raisonne par analogie : d'abord identifier la relation, ensuite la transférer. 2) Relation entre un doigt et la main : partie → tout. 3) On cherche la contrepartie de une branche qui honore la même relation. 4) Vérification : une branche se rapporte bien à la réponse comme un doigt se rapporte à la main. Donc : La réponse est « l'arbre » : la relation (partie → tout) est la même.",
    theme: "analogie",
  },
  {
    motif: "« une branche est à l'arbre comme un doigt est à … » — trouvez le mot manquant.",
    reponse: "1) On raisonne par analogie : d'abord identifier la relation, ensuite la transférer. 2) Relation entre une branche et l'arbre : partie → tout. 3) On cherche la contrepartie de un doigt qui honore la même relation. 4) Vérification : un doigt se rapporte bien à la réponse comme une branche se rapporte à l'arbre. Donc : La réponse est « la main » : la relation (partie → tout) est la même.",
    theme: "analogie",
  },
  {
    motif: "Analogie à compléter : un doigt : la main :: une branche : ?",
    reponse: "1) On raisonne par analogie : d'abord identifier la relation, ensuite la transférer. 2) Relation entre un doigt et la main : partie → tout. 3) On cherche la contrepartie de une branche qui honore la même relation. 4) Vérification : une branche se rapporte bien à la réponse comme un doigt se rapporte à la main. Donc : La réponse est « l'arbre » : la relation (partie → tout) est la même.",
    theme: "analogie",
  },
  {
    motif: "Analogie à compléter : une branche : l'arbre :: un doigt : ?",
    reponse: "1) On raisonne par analogie : d'abord identifier la relation, ensuite la transférer. 2) Relation entre une branche et l'arbre : partie → tout. 3) On cherche la contrepartie de un doigt qui honore la même relation. 4) Vérification : un doigt se rapporte bien à la réponse comme une branche se rapporte à l'arbre. Donc : La réponse est « la main » : la relation (partie → tout) est la même.",
    theme: "analogie",
  },
  {
    motif: "Trouvez la relation puis la réponse : un doigt est à la main ce que une branche est à quoi ?",
    reponse: "1) On raisonne par analogie : d'abord identifier la relation, ensuite la transférer. 2) Relation entre un doigt et la main : partie → tout. 3) On cherche la contrepartie de une branche qui honore la même relation. 4) Vérification : une branche se rapporte bien à la réponse comme un doigt se rapporte à la main. Donc : La réponse est « l'arbre » : la relation (partie → tout) est la même.",
    theme: "analogie",
  },
  {
    motif: "Trouvez la relation puis la réponse : une branche est à l'arbre ce que un doigt est à quoi ?",
    reponse: "1) On raisonne par analogie : d'abord identifier la relation, ensuite la transférer. 2) Relation entre une branche et l'arbre : partie → tout. 3) On cherche la contrepartie de un doigt qui honore la même relation. 4) Vérification : un doigt se rapporte bien à la réponse comme une branche se rapporte à l'arbre. Donc : La réponse est « la main » : la relation (partie → tout) est la même.",
    theme: "analogie",
  },
  {
    motif: "Complétez l'analogie : une page est à le livre ce que une brique est à quoi ?",
    reponse: "1) On raisonne par analogie : d'abord identifier la relation, ensuite la transférer. 2) Relation entre une page et le livre : élément → édifice. 3) On cherche la contrepartie de une brique qui honore la même relation. 4) Vérification : une brique se rapporte bien à la réponse comme une page se rapporte à le livre. Donc : La réponse est « la maison » : la relation (élément → édifice) est la même.",
    theme: "analogie",
  },
  {
    motif: "Complétez l'analogie : une brique est à la maison ce que une page est à quoi ?",
    reponse: "1) On raisonne par analogie : d'abord identifier la relation, ensuite la transférer. 2) Relation entre une brique et la maison : élément → édifice. 3) On cherche la contrepartie de une page qui honore la même relation. 4) Vérification : une page se rapporte bien à la réponse comme une brique se rapporte à la maison. Donc : La réponse est « le livre » : la relation (élément → édifice) est la même.",
    theme: "analogie",
  },
  {
    motif: "« une page est à le livre comme une brique est à … » — trouvez le mot manquant.",
    reponse: "1) On raisonne par analogie : d'abord identifier la relation, ensuite la transférer. 2) Relation entre une page et le livre : élément → édifice. 3) On cherche la contrepartie de une brique qui honore la même relation. 4) Vérification : une brique se rapporte bien à la réponse comme une page se rapporte à le livre. Donc : La réponse est « la maison » : la relation (élément → édifice) est la même.",
    theme: "analogie",
  },
  {
    motif: "« une brique est à la maison comme une page est à … » — trouvez le mot manquant.",
    reponse: "1) On raisonne par analogie : d'abord identifier la relation, ensuite la transférer. 2) Relation entre une brique et la maison : élément → édifice. 3) On cherche la contrepartie de une page qui honore la même relation. 4) Vérification : une page se rapporte bien à la réponse comme une brique se rapporte à la maison. Donc : La réponse est « le livre » : la relation (élément → édifice) est la même.",
    theme: "analogie",
  },
  {
    motif: "Que se passe-t-il si on n'arrose pas une plante pendant des semaines, et pourquoi ?",
    reponse: "1) On suit la chaîne cause → effet → mécanisme. 2) Cause : on n'arrose pas une plante pendant des semaines. 3) Effet observé : elle se dessèche puis meurt. 4) Mécanisme : l'eau monte des racines et maintient la pression des cellules ; sans elle, la plante se vide. Donc : Elle se dessèche puis meurt — parce que l'eau monte des racines et maintient la pression des cellules ; sans elle, la plante se vide.",
    theme: "causalite",
  },
  {
    motif: "Cause à effet : on n'arrose pas une plante pendant des semaines. Décrivez la conséquence et son mécanisme.",
    reponse: "1) On suit la chaîne cause → effet → mécanisme. 2) Cause : on n'arrose pas une plante pendant des semaines. 3) Effet observé : elle se dessèche puis meurt. 4) Mécanisme : l'eau monte des racines et maintient la pression des cellules ; sans elle, la plante se vide. Donc : Elle se dessèche puis meurt — parce que l'eau monte des racines et maintient la pression des cellules ; sans elle, la plante se vide.",
    theme: "causalite",
  },
  {
    motif: "Expliquez la chaîne causale quand on n'arrose pas une plante pendant des semaines.",
    reponse: "1) On suit la chaîne cause → effet → mécanisme. 2) Cause : on n'arrose pas une plante pendant des semaines. 3) Effet observé : elle se dessèche puis meurt. 4) Mécanisme : l'eau monte des racines et maintient la pression des cellules ; sans elle, la plante se vide. Donc : Elle se dessèche puis meurt — parce que l'eau monte des racines et maintient la pression des cellules ; sans elle, la plante se vide.",
    theme: "causalite",
  },
  {
    motif: "Un enfant demande : « Pourquoi, quand on n'arrose pas une plante pendant des semaines, quelque chose change ? » Répondez simplement.",
    reponse: "1) On suit la chaîne cause → effet → mécanisme. 2) Cause : on n'arrose pas une plante pendant des semaines. 3) Effet observé : elle se dessèche puis meurt. 4) Mécanisme : l'eau monte des racines et maintient la pression des cellules ; sans elle, la plante se vide. Donc : Elle se dessèche puis meurt — parce que l'eau monte des racines et maintient la pression des cellules ; sans elle, la plante se vide.",
    theme: "causalite",
  },
  {
    motif: "Que se passe-t-il si on laisse une fenêtre ouverte sous l'orage, et pourquoi ?",
    reponse: "1) On suit la chaîne cause → effet → mécanisme. 2) Cause : on laisse une fenêtre ouverte sous l'orage. 3) Effet observé : le sol et les meubles proches se mouillent. 4) Mécanisme : la pluie portée par le vent entre dans la pièce. Donc : Le sol et les meubles proches se mouillent — parce que la pluie portée par le vent entre dans la pièce.",
    theme: "causalite",
  },
  {
    motif: "Cause à effet : on laisse une fenêtre ouverte sous l'orage. Décrivez la conséquence et son mécanisme.",
    reponse: "1) On suit la chaîne cause → effet → mécanisme. 2) Cause : on laisse une fenêtre ouverte sous l'orage. 3) Effet observé : le sol et les meubles proches se mouillent. 4) Mécanisme : la pluie portée par le vent entre dans la pièce. Donc : Le sol et les meubles proches se mouillent — parce que la pluie portée par le vent entre dans la pièce.",
    theme: "causalite",
  },
  {
    motif: "Expliquez la chaîne causale quand on laisse une fenêtre ouverte sous l'orage.",
    reponse: "1) On suit la chaîne cause → effet → mécanisme. 2) Cause : on laisse une fenêtre ouverte sous l'orage. 3) Effet observé : le sol et les meubles proches se mouillent. 4) Mécanisme : la pluie portée par le vent entre dans la pièce. Donc : Le sol et les meubles proches se mouillent — parce que la pluie portée par le vent entre dans la pièce.",
    theme: "causalite",
  },
  {
    motif: "Un enfant demande : « Pourquoi, quand on laisse une fenêtre ouverte sous l'orage, quelque chose change ? » Répondez simplement.",
    reponse: "1) On suit la chaîne cause → effet → mécanisme. 2) Cause : on laisse une fenêtre ouverte sous l'orage. 3) Effet observé : le sol et les meubles proches se mouillent. 4) Mécanisme : la pluie portée par le vent entre dans la pièce. Donc : Le sol et les meubles proches se mouillent — parce que la pluie portée par le vent entre dans la pièce.",
    theme: "causalite",
  },
  {
    motif: "Que se passe-t-il si on oublie de sortir la glace du congélateur avant les invités, et pourquoi ?",
    reponse: "1) On suit la chaîne cause → effet → mécanisme. 2) Cause : on oublie de sortir la glace du congélateur avant les invités. 3) Effet observé : elle est trop dure à servir. 4) Mécanisme : la température du congélateur maintient l'eau sous son point de fusion. Donc : Elle est trop dure à servir — parce que la température du congélateur maintient l'eau sous son point de fusion.",
    theme: "causalite",
  },
  {
    motif: "Cause à effet : on oublie de sortir la glace du congélateur avant les invités. Décrivez la conséquence et son mécanisme.",
    reponse: "1) On suit la chaîne cause → effet → mécanisme. 2) Cause : on oublie de sortir la glace du congélateur avant les invités. 3) Effet observé : elle est trop dure à servir. 4) Mécanisme : la température du congélateur maintient l'eau sous son point de fusion. Donc : Elle est trop dure à servir — parce que la température du congélateur maintient l'eau sous son point de fusion.",
    theme: "causalite",
  },
  {
    motif: "Expliquez la chaîne causale quand on oublie de sortir la glace du congélateur avant les invités.",
    reponse: "1) On suit la chaîne cause → effet → mécanisme. 2) Cause : on oublie de sortir la glace du congélateur avant les invités. 3) Effet observé : elle est trop dure à servir. 4) Mécanisme : la température du congélateur maintient l'eau sous son point de fusion. Donc : Elle est trop dure à servir — parce que la température du congélateur maintient l'eau sous son point de fusion.",
    theme: "causalite",
  },
  {
    motif: "Un enfant demande : « Pourquoi, quand on oublie de sortir la glace du congélateur avant les invités, quelque chose change ? » Répondez simplement.",
    reponse: "1) On suit la chaîne cause → effet → mécanisme. 2) Cause : on oublie de sortir la glace du congélateur avant les invités. 3) Effet observé : elle est trop dure à servir. 4) Mécanisme : la température du congélateur maintient l'eau sous son point de fusion. Donc : Elle est trop dure à servir — parce que la température du congélateur maintient l'eau sous son point de fusion.",
    theme: "causalite",
  },
  {
    motif: "Que va-t-il se passer si on laisse une boule de glace dix minutes au soleil, et pourquoi ?",
    reponse: "1) Le bon sens s'appuie sur l'expérience partagée du monde. 2) Situation : on laisse une boule de glace dix minutes au soleil. 3) Issue attendue : elle fond progressivement. 4) Pourquoi : la chaleur fait passer l'eau de l'état solide à l'état liquide. Donc : Elle fond progressivement — la chaleur fait passer l'eau de l'état solide à l'état liquide.",
    theme: "sens_commun",
  },
  {
    motif: "Bon sens : on laisse une boule de glace dix minutes au soleil. Prévoyez l'issue et expliquez-la.",
    reponse: "1) Le bon sens s'appuie sur l'expérience partagée du monde. 2) Situation : on laisse une boule de glace dix minutes au soleil. 3) Issue attendue : elle fond progressivement. 4) Pourquoi : la chaleur fait passer l'eau de l'état solide à l'état liquide. Donc : Elle fond progressivement — la chaleur fait passer l'eau de l'état solide à l'état liquide.",
    theme: "sens_commun",
  },
  {
    motif: "On laisse une boule de glace dix minutes au soleil. Qu'arrive-t-il, et quel en est le principe ?",
    reponse: "1) Le bon sens s'appuie sur l'expérience partagée du monde. 2) Situation : on laisse une boule de glace dix minutes au soleil. 3) Issue attendue : elle fond progressivement. 4) Pourquoi : la chaleur fait passer l'eau de l'état solide à l'état liquide. Donc : Elle fond progressivement — la chaleur fait passer l'eau de l'état solide à l'état liquide.",
    theme: "sens_commun",
  },
  {
    motif: "Un enfant vous demande ce qui se passe quand on laisse une boule de glace dix minutes au soleil. Répondez en une explication claire.",
    reponse: "1) Le bon sens s'appuie sur l'expérience partagée du monde. 2) Situation : on laisse une boule de glace dix minutes au soleil. 3) Issue attendue : elle fond progressivement. 4) Pourquoi : la chaleur fait passer l'eau de l'état solide à l'état liquide. Donc : Elle fond progressivement — la chaleur fait passer l'eau de l'état solide à l'état liquide.",
    theme: "sens_commun",
  },
  {
    motif: "Que va-t-il se passer si on sort d'un bâtiment frais un jour d'été humide, et pourquoi ?",
    reponse: "1) Le bon sens s'appuie sur l'expérience partagée du monde. 2) Situation : on sort d'un bâtiment frais un jour d'été humide. 3) Issue attendue : les lunettes se couvrent de buée. 4) Pourquoi : la vapeur d'eau de l'air chaud se condense sur la surface froide. Donc : Les lunettes se couvrent de buée — la vapeur d'eau de l'air chaud se condense sur la surface froide.",
    theme: "sens_commun",
  },
  {
    motif: "Bon sens : on sort d'un bâtiment frais un jour d'été humide. Prévoyez l'issue et expliquez-la.",
    reponse: "1) Le bon sens s'appuie sur l'expérience partagée du monde. 2) Situation : on sort d'un bâtiment frais un jour d'été humide. 3) Issue attendue : les lunettes se couvrent de buée. 4) Pourquoi : la vapeur d'eau de l'air chaud se condense sur la surface froide. Donc : Les lunettes se couvrent de buée — la vapeur d'eau de l'air chaud se condense sur la surface froide.",
    theme: "sens_commun",
  },
  {
    motif: "On sort d'un bâtiment frais un jour d'été humide. Qu'arrive-t-il, et quel en est le principe ?",
    reponse: "1) Le bon sens s'appuie sur l'expérience partagée du monde. 2) Situation : on sort d'un bâtiment frais un jour d'été humide. 3) Issue attendue : les lunettes se couvrent de buée. 4) Pourquoi : la vapeur d'eau de l'air chaud se condense sur la surface froide. Donc : Les lunettes se couvrent de buée — la vapeur d'eau de l'air chaud se condense sur la surface froide.",
    theme: "sens_commun",
  },
  {
    motif: "Un enfant vous demande ce qui se passe quand on sort d'un bâtiment frais un jour d'été humide. Répondez en une explication claire.",
    reponse: "1) Le bon sens s'appuie sur l'expérience partagée du monde. 2) Situation : on sort d'un bâtiment frais un jour d'été humide. 3) Issue attendue : les lunettes se couvrent de buée. 4) Pourquoi : la vapeur d'eau de l'air chaud se condense sur la surface froide. Donc : Les lunettes se couvrent de buée — la vapeur d'eau de l'air chaud se condense sur la surface froide.",
    theme: "sens_commun",
  },
  {
    motif: "Que va-t-il se passer si on secoue un soda avant de l'ouvrir, et pourquoi ?",
    reponse: "1) Le bon sens s'appuie sur l'expérience partagée du monde. 2) Situation : on secoue un soda avant de l'ouvrir. 3) Issue attendue : il gicle. 4) Pourquoi : le gaz dissous se libère brutalement quand la pression chute. Donc : Il gicle — le gaz dissous se libère brutalement quand la pression chute.",
    theme: "sens_commun",
  },
  {
    motif: "Bon sens : on secoue un soda avant de l'ouvrir. Prévoyez l'issue et expliquez-la.",
    reponse: "1) Le bon sens s'appuie sur l'expérience partagée du monde. 2) Situation : on secoue un soda avant de l'ouvrir. 3) Issue attendue : il gicle. 4) Pourquoi : le gaz dissous se libère brutalement quand la pression chute. Donc : Il gicle — le gaz dissous se libère brutalement quand la pression chute.",
    theme: "sens_commun",
  },
  {
    motif: "On secoue un soda avant de l'ouvrir. Qu'arrive-t-il, et quel en est le principe ?",
    reponse: "1) Le bon sens s'appuie sur l'expérience partagée du monde. 2) Situation : on secoue un soda avant de l'ouvrir. 3) Issue attendue : il gicle. 4) Pourquoi : le gaz dissous se libère brutalement quand la pression chute. Donc : Il gicle — le gaz dissous se libère brutalement quand la pression chute.",
    theme: "sens_commun",
  },
  {
    motif: "Un enfant vous demande ce qui se passe quand on secoue un soda avant de l'ouvrir. Répondez en une explication claire.",
    reponse: "1) Le bon sens s'appuie sur l'expérience partagée du monde. 2) Situation : on secoue un soda avant de l'ouvrir. 3) Issue attendue : il gicle. 4) Pourquoi : le gaz dissous se libère brutalement quand la pression chute. Donc : Il gicle — le gaz dissous se libère brutalement quand la pression chute.",
    theme: "sens_commun",
  },
  {
    motif: "Petite histoire : Alice cache un colis dans l'armoire du couloir. Bernard est dans la pièce et voit tout.. Que fera Bernard ?",
    reponse: "1) Alice cache un colis dans l'armoire du couloir. 2) Bernard est présent et voit tout. 3) Bernard a donc l'information : il sait où est un colis. 4) On agit d'après ce qu'on sait, pas d'après la réalité seule. Donc : Oui : Bernard cherchera un colis dans l'armoire du couloir, car il l'a vu — il sait.",
    theme: "theorie_esprit",
  },
  {
    motif: "Alice cache un colis dans l'armoire du couloir. Bernard est dans la pièce et voit tout. — que peut-on prédire sur Bernard ?",
    reponse: "1) Alice cache un colis dans l'armoire du couloir. 2) Bernard est présent et voit tout. 3) Bernard a donc l'information : il sait où est un colis. 4) On agit d'après ce qu'on sait, pas d'après la réalité seule. Donc : Oui : Bernard cherchera un colis dans l'armoire du couloir, car il l'a vu — il sait.",
    theme: "theorie_esprit",
  },
  {
    motif: "Théorie de l'esprit : Alice cache un colis dans l'armoire du couloir. Bernard est dans la pièce et voit tout. Que va faire Bernard, et pourquoi ?",
    reponse: "1) Alice cache un colis dans l'armoire du couloir. 2) Bernard est présent et voit tout. 3) Bernard a donc l'information : il sait où est un colis. 4) On agit d'après ce qu'on sait, pas d'après la réalité seule. Donc : Oui : Bernard cherchera un colis dans l'armoire du couloir, car il l'a vu — il sait.",
    theme: "theorie_esprit",
  },
  {
    motif: "Petite histoire : Alice cache un colis dans l'armoire du couloir. Bernard n'était pas dans la pièce au moment du cachage.. Que fera Bernard ?",
    reponse: "1) Alice cache un colis dans l'armoire du couloir, mais Bernard n'a rien vu. 2) La croyance de Bernard est restée à l'ancien état du monde. 3) Il ne peut pas savoir ce qu'il ignore — c'est la fausse croyance. 4) Prédire correctement exige de distinguer le monde réel et ce que Bernard croit. Donc : Non : Bernard ne cherchera pas un colis dans l'armoire du couloir, car il n'a pas vu le cachage — il ne sait pas.",
    theme: "theorie_esprit",
  },
  {
    motif: "Alice cache un colis dans l'armoire du couloir. Bernard n'était pas dans la pièce au moment du cachage. — que peut-on prédire sur Bernard ?",
    reponse: "1) Alice cache un colis dans l'armoire du couloir, mais Bernard n'a rien vu. 2) La croyance de Bernard est restée à l'ancien état du monde. 3) Il ne peut pas savoir ce qu'il ignore — c'est la fausse croyance. 4) Prédire correctement exige de distinguer le monde réel et ce que Bernard croit. Donc : Non : Bernard ne cherchera pas un colis dans l'armoire du couloir, car il n'a pas vu le cachage — il ne sait pas.",
    theme: "theorie_esprit",
  },
  {
    motif: "Théorie de l'esprit : Alice cache un colis dans l'armoire du couloir. Bernard n'était pas dans la pièce au moment du cachage. Que va faire Bernard, et pourquoi ?",
    reponse: "1) Alice cache un colis dans l'armoire du couloir, mais Bernard n'a rien vu. 2) La croyance de Bernard est restée à l'ancien état du monde. 3) Il ne peut pas savoir ce qu'il ignore — c'est la fausse croyance. 4) Prédire correctement exige de distinguer le monde réel et ce que Bernard croit. Donc : Non : Bernard ne cherchera pas un colis dans l'armoire du couloir, car il n'a pas vu le cachage — il ne sait pas.",
    theme: "theorie_esprit",
  },
  {
    motif: "Petite histoire : Alice cache un colis dans l'armoire du couloir, puis va le raconter à Bernard.. Que fera Bernard ?",
    reponse: "1) Bernard n'a pas vu le cachage… mais Alice lui a raconté. 2) L'information transmise par le langage met à jour la croyance. 3) Voir n'est pas la seule source : se faire raconter suffit. Donc : Oui : Bernard cherchera un colis dans l'armoire du couloir, car Alice le lui a raconté — il est informé.",
    theme: "theorie_esprit",
  },
  {
    motif: "Alice cache un colis dans l'armoire du couloir, puis va le raconter à Bernard. — que peut-on prédire sur Bernard ?",
    reponse: "1) Bernard n'a pas vu le cachage… mais Alice lui a raconté. 2) L'information transmise par le langage met à jour la croyance. 3) Voir n'est pas la seule source : se faire raconter suffit. Donc : Oui : Bernard cherchera un colis dans l'armoire du couloir, car Alice le lui a raconté — il est informé.",
    theme: "theorie_esprit",
  },
  {
    motif: "Théorie de l'esprit : Alice cache un colis dans l'armoire du couloir, puis va le raconter à Bernard. Que va faire Bernard, et pourquoi ?",
    reponse: "1) Bernard n'a pas vu le cachage… mais Alice lui a raconté. 2) L'information transmise par le langage met à jour la croyance. 3) Voir n'est pas la seule source : se faire raconter suffit. Donc : Oui : Bernard cherchera un colis dans l'armoire du couloir, car Alice le lui a raconté — il est informé.",
    theme: "theorie_esprit",
  },
  {
    motif: "Petite histoire : Alice cache un colis sous le lit. Bernard est dans la pièce et voit tout.. Que fera Bernard ?",
    reponse: "1) Alice cache un colis sous le lit. 2) Bernard est présent et voit tout. 3) Bernard a donc l'information : il sait où est un colis. 4) On agit d'après ce qu'on sait, pas d'après la réalité seule. Donc : Oui : Bernard cherchera un colis sous le lit, car il l'a vu — il sait.",
    theme: "theorie_esprit",
  },
  {
    motif: "Alice cache un colis sous le lit. Bernard est dans la pièce et voit tout. — que peut-on prédire sur Bernard ?",
    reponse: "1) Alice cache un colis sous le lit. 2) Bernard est présent et voit tout. 3) Bernard a donc l'information : il sait où est un colis. 4) On agit d'après ce qu'on sait, pas d'après la réalité seule. Donc : Oui : Bernard cherchera un colis sous le lit, car il l'a vu — il sait.",
    theme: "theorie_esprit",
  },
  {
    motif: "Théorie de l'esprit : Alice cache un colis sous le lit. Bernard est dans la pièce et voit tout. Que va faire Bernard, et pourquoi ?",
    reponse: "1) Alice cache un colis sous le lit. 2) Bernard est présent et voit tout. 3) Bernard a donc l'information : il sait où est un colis. 4) On agit d'après ce qu'on sait, pas d'après la réalité seule. Donc : Oui : Bernard cherchera un colis sous le lit, car il l'a vu — il sait.",
    theme: "theorie_esprit",
  },
  {
    motif: "Comment s'y prendre pour organiser un pique-nique ? Donnez les étapes.",
    reponse: "1) On planifie : objectif → sous-étapes ordonnées, chacune vérifiable. 2) Objectif : organiser un pique-nique. 3) Étape 1 : choisir la date et vérifier la météo. 4) Étape 2 : fixer le lieu et prévenir les participants. 5) Étape 3 : répartir les plats et les boissons. 6) Étape 4 : préparer la glacière, les nappes et les jeux. 7) Étape 5 : prévoir un plan B en cas de pluie. 8) On garde une marge pour les imprévus : une planification sans réserve est fragile. Donc : Le chemin : choisir la date et vérifier la météo → fixer le lieu et prévenir les participants → répartir les plats et les boissons → préparer la glacière, les nappes et les jeux → prévoir un plan B en cas de pluie.",
    theme: "planification",
  },
  {
    motif: "Objectif : organiser un pique-nique. Décomposez le chemin en étapes claires.",
    reponse: "1) On planifie : objectif → sous-étapes ordonnées, chacune vérifiable. 2) Objectif : organiser un pique-nique. 3) Étape 1 : choisir la date et vérifier la météo. 4) Étape 2 : fixer le lieu et prévenir les participants. 5) Étape 3 : répartir les plats et les boissons. 6) Étape 4 : préparer la glacière, les nappes et les jeux. 7) Étape 5 : prévoir un plan B en cas de pluie. 8) On garde une marge pour les imprévus : une planification sans réserve est fragile. Donc : Le chemin : choisir la date et vérifier la météo → fixer le lieu et prévenir les participants → répartir les plats et les boissons → préparer la glacière, les nappes et les jeux → prévoir un plan B en cas de pluie.",
    theme: "planification",
  },
  {
    motif: "Je voudrais organiser un pique-nique — aide-moi à planifier, étape par étape.",
    reponse: "1) On planifie : objectif → sous-étapes ordonnées, chacune vérifiable. 2) Objectif : organiser un pique-nique. 3) Étape 1 : choisir la date et vérifier la météo. 4) Étape 2 : fixer le lieu et prévenir les participants. 5) Étape 3 : répartir les plats et les boissons. 6) Étape 4 : préparer la glacière, les nappes et les jeux. 7) Étape 5 : prévoir un plan B en cas de pluie. 8) On garde une marge pour les imprévus : une planification sans réserve est fragile. Donc : Le chemin : choisir la date et vérifier la météo → fixer le lieu et prévenir les participants → répartir les plats et les boissons → préparer la glacière, les nappes et les jeux → prévoir un plan B en cas de pluie.",
    theme: "planification",
  },
  {
    motif: "Comment s'y prendre pour monter une étagère murale ? Donnez les étapes.",
    reponse: "1) On planifie : objectif → sous-étapes ordonnées, chacune vérifiable. 2) Objectif : monter une étagère murale. 3) Étape 1 : repérer le mur et les fixations adaptées. 4) Étape 2 : tracer le niveau au crayon. 5) Étape 3 : percer les trous aux repères. 6) Étape 4 : poser les chevilles et les supports. 7) Étape 5 : fixer l'étagère et vérifier l'horizontalité. 8) On garde une marge pour les imprévus : une planification sans réserve est fragile. Donc : Le chemin : repérer le mur et les fixations adaptées → tracer le niveau au crayon → percer les trous aux repères → poser les chevilles et les supports → fixer l'étagère et vérifier l'horizontalité.",
    theme: "planification",
  },
  {
    motif: "Comment s'y prendre pour monter une étagère murale ? Donnez les étapes. (avec un petit budget et beaucoup de temps)",
    reponse: "1) On planifie : objectif → sous-étapes ordonnées, chacune vérifiable. 2) Objectif : monter une étagère murale (avec un petit budget et beaucoup de temps). 3) Étape 1 : repérer le mur et les fixations adaptées. 4) Étape 2 : tracer le niveau au crayon. 5) Étape 3 : percer les trous aux repères. 6) Étape 4 : poser les chevilles et les supports. 7) Étape 5 : fixer l'étagère et vérifier l'horizontalité. 8) On garde une marge pour les imprévus : une planification sans réserve est fragile. Donc : Le chemin : repérer le mur et les fixations adaptées → tracer le niveau au crayon → percer les trous aux repères → poser les chevilles et les supports → fixer l'étagère et vérifier l'horizontalité.",
    theme: "planification",
  },
  {
    motif: "Objectif : monter une étagère murale. Décomposez le chemin en étapes claires.",
    reponse: "1) On planifie : objectif → sous-étapes ordonnées, chacune vérifiable. 2) Objectif : monter une étagère murale. 3) Étape 1 : repérer le mur et les fixations adaptées. 4) Étape 2 : tracer le niveau au crayon. 5) Étape 3 : percer les trous aux repères. 6) Étape 4 : poser les chevilles et les supports. 7) Étape 5 : fixer l'étagère et vérifier l'horizontalité. 8) On garde une marge pour les imprévus : une planification sans réserve est fragile. Donc : Le chemin : repérer le mur et les fixations adaptées → tracer le niveau au crayon → percer les trous aux repères → poser les chevilles et les supports → fixer l'étagère et vérifier l'horizontalité.",
    theme: "planification",
  },
  {
    motif: "Objectif : monter une étagère murale. Décomposez le chemin en étapes claires. (avec un petit budget et beaucoup de temps)",
    reponse: "1) On planifie : objectif → sous-étapes ordonnées, chacune vérifiable. 2) Objectif : monter une étagère murale (avec un petit budget et beaucoup de temps). 3) Étape 1 : repérer le mur et les fixations adaptées. 4) Étape 2 : tracer le niveau au crayon. 5) Étape 3 : percer les trous aux repères. 6) Étape 4 : poser les chevilles et les supports. 7) Étape 5 : fixer l'étagère et vérifier l'horizontalité. 8) On garde une marge pour les imprévus : une planification sans réserve est fragile. Donc : Le chemin : repérer le mur et les fixations adaptées → tracer le niveau au crayon → percer les trous aux repères → poser les chevilles et les supports → fixer l'étagère et vérifier l'horizontalité.",
    theme: "planification",
  },
  {
    motif: "Je voudrais monter une étagère murale — aide-moi à planifier, étape par étape.",
    reponse: "1) On planifie : objectif → sous-étapes ordonnées, chacune vérifiable. 2) Objectif : monter une étagère murale. 3) Étape 1 : repérer le mur et les fixations adaptées. 4) Étape 2 : tracer le niveau au crayon. 5) Étape 3 : percer les trous aux repères. 6) Étape 4 : poser les chevilles et les supports. 7) Étape 5 : fixer l'étagère et vérifier l'horizontalité. 8) On garde une marge pour les imprévus : une planification sans réserve est fragile. Donc : Le chemin : repérer le mur et les fixations adaptées → tracer le niveau au crayon → percer les trous aux repères → poser les chevilles et les supports → fixer l'étagère et vérifier l'horizontalité.",
    theme: "planification",
  },
  {
    motif: "Je voudrais monter une étagère murale — aide-moi à planifier, étape par étape. (avec un petit budget et beaucoup de temps)",
    reponse: "1) On planifie : objectif → sous-étapes ordonnées, chacune vérifiable. 2) Objectif : monter une étagère murale (avec un petit budget et beaucoup de temps). 3) Étape 1 : repérer le mur et les fixations adaptées. 4) Étape 2 : tracer le niveau au crayon. 5) Étape 3 : percer les trous aux repères. 6) Étape 4 : poser les chevilles et les supports. 7) Étape 5 : fixer l'étagère et vérifier l'horizontalité. 8) On garde une marge pour les imprévus : une planification sans réserve est fragile. Donc : Le chemin : repérer le mur et les fixations adaptées → tracer le niveau au crayon → percer les trous aux repères → poser les chevilles et les supports → fixer l'étagère et vérifier l'horizontalité.",
    theme: "planification",
  },
  {
    motif: "Comment s'y prendre pour planter un potager en carrés ? Donnez les étapes.",
    reponse: "1) On planifie : objectif → sous-étapes ordonnées, chacune vérifiable. 2) Objectif : planter un potager en carrés. 3) Étape 1 : choisir l'emplacement le plus ensoleillé. 4) Étape 2 : construire ou installer les carrés. 5) Étape 3 : préparer un mélange terre/compost. 6) Étape 4 : planifier les cultures par saison. 7) Étape 5 : semer, arroser et pailler régulièrement. 8) On garde une marge pour les imprévus : une planification sans réserve est fragile. Donc : Le chemin : choisir l'emplacement le plus ensoleillé → construire ou installer les carrés → préparer un mélange terre/compost → planifier les cultures par saison → semer, arroser et pailler régulièrement.",
    theme: "planification",
  },
  {
    motif: "Objectif : planter un potager en carrés. Décomposez le chemin en étapes claires.",
    reponse: "1) On planifie : objectif → sous-étapes ordonnées, chacune vérifiable. 2) Objectif : planter un potager en carrés. 3) Étape 1 : choisir l'emplacement le plus ensoleillé. 4) Étape 2 : construire ou installer les carrés. 5) Étape 3 : préparer un mélange terre/compost. 6) Étape 4 : planifier les cultures par saison. 7) Étape 5 : semer, arroser et pailler régulièrement. 8) On garde une marge pour les imprévus : une planification sans réserve est fragile. Donc : Le chemin : choisir l'emplacement le plus ensoleillé → construire ou installer les carrés → préparer un mélange terre/compost → planifier les cultures par saison → semer, arroser et pailler régulièrement.",
    theme: "planification",
  },
  {
    motif: "Comment s'y prendre pour organiser un vide-grenier ? Donnez les étapes.",
    reponse: "1) On planifie : objectif → sous-étapes ordonnées, chacune vérifiable. 2) Objectif : organiser un vide-grenier. 3) Étape 1 : vérifier la réglementation locale. 4) Étape 2 : réserver l'emplacement à la mairie. 5) Étape 3 : trier et étiqueter les objets. 6) Étape 4 : prévoir tables, monnaie et ombre. 7) Étape 5 : prévoir la reprise des invendus (don, déchetterie). 8) On garde une marge pour les imprévus : une planification sans réserve est fragile. Donc : Le chemin : vérifier la réglementation locale → réserver l'emplacement à la mairie → trier et étiqueter les objets → prévoir tables, monnaie et ombre → prévoir la reprise des invendus (don, déchetterie).",
    theme: "planification",
  },
  {
    motif: "Au marché : quelqu'un dépense 2 € puis encore 2 €. Combien a-t-il dépensé en tout ?",
    reponse: "1) On repère l'opération : deux dépenses successives s'additionnent. 2) Première dépense : 2 €. Seconde : 2 €. 3) Somme : 2 + 2 = 4. Donc : Il a dépensé 4 € au total.",
    theme: "math_verbal",
  },
  {
    motif: "Au marché : il avait 3 € et il en dépense 2. Combien lui reste-t-il ?",
    reponse: "1) On repère l'opération : dépenser, c'est soustraire de l'argent disponible. 2) Disponible : 3 €. Dépensé : 2 €. 3) Reste : 3 − 2 = 1. Donc : Il lui reste 1 €.",
    theme: "math_verbal",
  },
  {
    motif: "Au marché : on partage 3 jetons entre 2 joueurs équitablement. Combien chacun reçoit-il, et combien reste-t-il ?",
    reponse: "1) Un partage équitable, c'est une division euclidienne. 2) Jetons : 3. Joueurs : 2. 3) Quotient : 3 ÷ 2 = 1, reste 1. Donc : Chacun reçoit 1 jetons, et il reste 1 jeton de côté.",
    theme: "math_verbal",
  },
  {
    motif: "Au marché : on double une quantité de 1 objets. Combien obtient-on ?",
    reponse: "1) Doubler, c'est multiplier par deux. 2) Quantité : 1. 3) Double : 1 × 2 = 2. Donc : On obtient 2 objets.",
    theme: "math_verbal",
  },
  {
    motif: "À la boulangerie : quelqu'un dépense 2 € puis encore 2 €. Combien a-t-il dépensé en tout ?",
    reponse: "1) On repère l'opération : deux dépenses successives s'additionnent. 2) Première dépense : 2 €. Seconde : 2 €. 3) Somme : 2 + 2 = 4. Donc : Il a dépensé 4 € au total.",
    theme: "math_verbal",
  },
  {
    motif: "À la boulangerie : il avait 3 € et il en dépense 2. Combien lui reste-t-il ?",
    reponse: "1) On repère l'opération : dépenser, c'est soustraire de l'argent disponible. 2) Disponible : 3 €. Dépensé : 2 €. 3) Reste : 3 − 2 = 1. Donc : Il lui reste 1 €.",
    theme: "math_verbal",
  },
  {
    motif: "À la boulangerie : on partage 3 jetons entre 2 joueurs équitablement. Combien chacun reçoit-il, et combien reste-t-il ?",
    reponse: "1) Un partage équitable, c'est une division euclidienne. 2) Jetons : 3. Joueurs : 2. 3) Quotient : 3 ÷ 2 = 1, reste 1. Donc : Chacun reçoit 1 jetons, et il reste 1 jeton de côté.",
    theme: "math_verbal",
  },
  {
    motif: "À la boulangerie : on double une quantité de 1 objets. Combien obtient-on ?",
    reponse: "1) Doubler, c'est multiplier par deux. 2) Quantité : 1. 3) Double : 1 × 2 = 2. Donc : On obtient 2 objets.",
    theme: "math_verbal",
  },
  {
    motif: "Pendant la kermesse : quelqu'un dépense 2 € puis encore 2 €. Combien a-t-il dépensé en tout ?",
    reponse: "1) On repère l'opération : deux dépenses successives s'additionnent. 2) Première dépense : 2 €. Seconde : 2 €. 3) Somme : 2 + 2 = 4. Donc : Il a dépensé 4 € au total.",
    theme: "math_verbal",
  },
  {
    motif: "Pendant la kermesse : il avait 3 € et il en dépense 2. Combien lui reste-t-il ?",
    reponse: "1) On repère l'opération : dépenser, c'est soustraire de l'argent disponible. 2) Disponible : 3 €. Dépensé : 2 €. 3) Reste : 3 − 2 = 1. Donc : Il lui reste 1 €.",
    theme: "math_verbal",
  },
  {
    motif: "Pendant la kermesse : on partage 3 jetons entre 2 joueurs équitablement. Combien chacun reçoit-il, et combien reste-t-il ?",
    reponse: "1) Un partage équitable, c'est une division euclidienne. 2) Jetons : 3. Joueurs : 2. 3) Quotient : 3 ÷ 2 = 1, reste 1. Donc : Chacun reçoit 1 jetons, et il reste 1 jeton de côté.",
    theme: "math_verbal",
  },
  {
    motif: "Pendant la kermesse : on double une quantité de 1 objets. Combien obtient-on ?",
    reponse: "1) Doubler, c'est multiplier par deux. 2) Quantité : 1. 3) Double : 1 × 2 = 2. Donc : On obtient 2 objets.",
    theme: "math_verbal",
  },
  {
    motif: "Quelqu'un dit : « Bravo, tu as encore oublié mes clés… » Qu'a-t-il vraiment voulu dire ?",
    reponse: "1) On lit entre les lignes : l'implicite pèse autant que le dit. 2) Énoncé : « Bravo, tu as encore oublié mes clés… » 3) Sens réel : c'est un reproche déguisé : la personne est contrariée. 4) L'indice qui donne le ton : le ton piqué et le mot « encore » qui pointe une habitude. Donc : Le message réel : c'est un reproche déguisé : la personne est contrariée (l'indice : le ton piqué et le mot « encore » qui pointe une habitude).",
    theme: "pragmatique",
  },
  {
    motif: "On vous lance : « Bravo, tu as encore oublié mes clés… » Quel est le sens caché ?",
    reponse: "1) On lit entre les lignes : l'implicite pèse autant que le dit. 2) Énoncé : « Bravo, tu as encore oublié mes clés… » 3) Sens réel : c'est un reproche déguisé : la personne est contrariée. 4) L'indice qui donne le ton : le ton piqué et le mot « encore » qui pointe une habitude. Donc : Le message réel : c'est un reproche déguisé : la personne est contrariée (l'indice : le ton piqué et le mot « encore » qui pointe une habitude).",
    theme: "pragmatique",
  },
  {
    motif: "Décodage social : « Bravo, tu as encore oublié mes clés… » — que faut-il comprendre ?",
    reponse: "1) On lit entre les lignes : l'implicite pèse autant que le dit. 2) Énoncé : « Bravo, tu as encore oublié mes clés… » 3) Sens réel : c'est un reproche déguisé : la personne est contrariée. 4) L'indice qui donne le ton : le ton piqué et le mot « encore » qui pointe une habitude. Donc : Le message réel : c'est un reproche déguisé : la personne est contrariée (l'indice : le ton piqué et le mot « encore » qui pointe une habitude).",
    theme: "pragmatique",
  },
  {
    motif: "Quelqu'un dit : « Il fait un peu frais ici, non ? » Qu'a-t-il vraiment voulu dire ?",
    reponse: "1) On lit entre les lignes : l'implicite pèse autant que le dit. 2) Énoncé : « Il fait un peu frais ici, non ? » 3) Sens réel : c'est une demande indirecte de fermer la fenêtre. 4) L'indice qui donne le ton : on commente l'ambiance pour susciter une action. Donc : Le message réel : c'est une demande indirecte de fermer la fenêtre (l'indice : on commente l'ambiance pour susciter une action).",
    theme: "pragmatique",
  },
  {
    motif: "On vous lance : « Il fait un peu frais ici, non ? » Quel est le sens caché ?",
    reponse: "1) On lit entre les lignes : l'implicite pèse autant que le dit. 2) Énoncé : « Il fait un peu frais ici, non ? » 3) Sens réel : c'est une demande indirecte de fermer la fenêtre. 4) L'indice qui donne le ton : on commente l'ambiance pour susciter une action. Donc : Le message réel : c'est une demande indirecte de fermer la fenêtre (l'indice : on commente l'ambiance pour susciter une action).",
    theme: "pragmatique",
  },
  {
    motif: "Décodage social : « Il fait un peu frais ici, non ? » — que faut-il comprendre ?",
    reponse: "1) On lit entre les lignes : l'implicite pèse autant que le dit. 2) Énoncé : « Il fait un peu frais ici, non ? » 3) Sens réel : c'est une demande indirecte de fermer la fenêtre. 4) L'indice qui donne le ton : on commente l'ambiance pour susciter une action. Donc : Le message réel : c'est une demande indirecte de fermer la fenêtre (l'indice : on commente l'ambiance pour susciter une action).",
    theme: "pragmatique",
  },
  {
    motif: "Quelqu'un dit : « Quelle surprise, tu es à l'heure ! » Qu'a-t-il vraiment voulu dire ?",
    reponse: "1) On lit entre les lignes : l'implicite pèse autant que le dit. 2) Énoncé : « Quelle surprise, tu es à l'heure ! » 3) Sens réel : c'est de l'ironie : la personne est d'habitude en retard. 4) L'indice qui donne le ton : l'exagération et le contexte d'habitude. Donc : Le message réel : c'est de l'ironie : la personne est d'habitude en retard (l'indice : l'exagération et le contexte d'habitude).",
    theme: "pragmatique",
  },
  {
    motif: "On vous lance : « Quelle surprise, tu es à l'heure ! » Quel est le sens caché ?",
    reponse: "1) On lit entre les lignes : l'implicite pèse autant que le dit. 2) Énoncé : « Quelle surprise, tu es à l'heure ! » 3) Sens réel : c'est de l'ironie : la personne est d'habitude en retard. 4) L'indice qui donne le ton : l'exagération et le contexte d'habitude. Donc : Le message réel : c'est de l'ironie : la personne est d'habitude en retard (l'indice : l'exagération et le contexte d'habitude).",
    theme: "pragmatique",
  },
  {
    motif: "Décodage social : « Quelle surprise, tu es à l'heure ! » — que faut-il comprendre ?",
    reponse: "1) On lit entre les lignes : l'implicite pèse autant que le dit. 2) Énoncé : « Quelle surprise, tu es à l'heure ! » 3) Sens réel : c'est de l'ironie : la personne est d'habitude en retard. 4) L'indice qui donne le ton : l'exagération et le contexte d'habitude. Donc : Le message réel : c'est de l'ironie : la personne est d'habitude en retard (l'indice : l'exagération et le contexte d'habitude).",
    theme: "pragmatique",
  },
  {
    motif: "Quelqu'un dit : « Je ne suis pas fâchée, mais… » Qu'a-t-il vraiment voulu dire ?",
    reponse: "1) On lit entre les lignes : l'implicite pèse autant que le dit. 2) Énoncé : « Je ne suis pas fâchée, mais… » 3) Sens réel : elle est fâchée, et une critique suit. 4) L'indice qui donne le ton : le « mais » qui annule la première partie. Donc : Le message réel : elle est fâchée, et une critique suit (l'indice : le « mais » qui annule la première partie).",
    theme: "pragmatique",
  },
  {
    motif: "On vous lance : « Je ne suis pas fâchée, mais… » Quel est le sens caché ?",
    reponse: "1) On lit entre les lignes : l'implicite pèse autant que le dit. 2) Énoncé : « Je ne suis pas fâchée, mais… » 3) Sens réel : elle est fâchée, et une critique suit. 4) L'indice qui donne le ton : le « mais » qui annule la première partie. Donc : Le message réel : elle est fâchée, et une critique suit (l'indice : le « mais » qui annule la première partie).",
    theme: "pragmatique",
  },
  {
    motif: "Décodage social : « Je ne suis pas fâchée, mais… » — que faut-il comprendre ?",
    reponse: "1) On lit entre les lignes : l'implicite pèse autant que le dit. 2) Énoncé : « Je ne suis pas fâchée, mais… » 3) Sens réel : elle est fâchée, et une critique suit. 4) L'indice qui donne le ton : le « mais » qui annule la première partie. Donc : Le message réel : elle est fâchée, et une critique suit (l'indice : le « mais » qui annule la première partie).",
    theme: "pragmatique",
  },
  {
    motif: "Situation : vous trouvez un portefeuille avec de l'argent et une carte d'identité. Que faut-il faire, et pourquoi ?",
    reponse: "1) On pèse les valeurs en jeu avant de décider — l'éthique pratique est une pesée, pas une formule. 2) Situation : vous trouvez un portefeuille avec de l'argent et une carte d'identité. 3) Valeurs en tension : l'appât du gain contre l'honnêteté et l'empathie. 4) Conduite retenue : essayer de le rendre : contacter le propriétaire ou le remettre à la police — l'argent n'est pas à nous, la perte d'un document coûte cher à son détenteur. Donc : Essayer de le rendre : contacter le propriétaire ou le remettre à la police — l'argent n'est pas à nous, la perte d'un document coûte cher à son détenteur.",
    theme: "ethique_pratique",
  },
  {
    motif: "Dilemme : vous trouvez un portefeuille avec de l'argent et une carte d'identité. Quelles valeurs s'affrontent et quelle conduite retenir ?",
    reponse: "1) On pèse les valeurs en jeu avant de décider — l'éthique pratique est une pesée, pas une formule. 2) Situation : vous trouvez un portefeuille avec de l'argent et une carte d'identité. 3) Valeurs en tension : l'appât du gain contre l'honnêteté et l'empathie. 4) Conduite retenue : essayer de le rendre : contacter le propriétaire ou le remettre à la police — l'argent n'est pas à nous, la perte d'un document coûte cher à son détenteur. Donc : Essayer de le rendre : contacter le propriétaire ou le remettre à la police — l'argent n'est pas à nous, la perte d'un document coûte cher à son détenteur.",
    theme: "ethique_pratique",
  },
  {
    motif: "Aide-moi à réfléchir : vous trouvez un portefeuille avec de l'argent et une carte d'identité. Quelle est la bonne conduite ?",
    reponse: "1) On pèse les valeurs en jeu avant de décider — l'éthique pratique est une pesée, pas une formule. 2) Situation : vous trouvez un portefeuille avec de l'argent et une carte d'identité. 3) Valeurs en tension : l'appât du gain contre l'honnêteté et l'empathie. 4) Conduite retenue : essayer de le rendre : contacter le propriétaire ou le remettre à la police — l'argent n'est pas à nous, la perte d'un document coûte cher à son détenteur. Donc : Essayer de le rendre : contacter le propriétaire ou le remettre à la police — l'argent n'est pas à nous, la perte d'un document coûte cher à son détenteur.",
    theme: "ethique_pratique",
  },
  {
    motif: "Situation : vous retrouvez la monnaie en trop après un achat. Que faut-il faire, et pourquoi ?",
    reponse: "1) On pèse les valeurs en jeu avant de décider — l'éthique pratique est une pesée, pas une formule. 2) Situation : vous retrouvez la monnaie en trop après un achat. 3) Valeurs en tension : le petit profit facile contre l'équité. 4) Conduite retenue : signaler l'erreur au commerçant : la confiance vaut plus que quelques pièces. Donc : Signaler l'erreur au commerçant : la confiance vaut plus que quelques pièces.",
    theme: "ethique_pratique",
  },
  {
    motif: "Dilemme : vous retrouvez la monnaie en trop après un achat. Quelles valeurs s'affrontent et quelle conduite retenir ?",
    reponse: "1) On pèse les valeurs en jeu avant de décider — l'éthique pratique est une pesée, pas une formule. 2) Situation : vous retrouvez la monnaie en trop après un achat. 3) Valeurs en tension : le petit profit facile contre l'équité. 4) Conduite retenue : signaler l'erreur au commerçant : la confiance vaut plus que quelques pièces. Donc : Signaler l'erreur au commerçant : la confiance vaut plus que quelques pièces.",
    theme: "ethique_pratique",
  },
  {
    motif: "Aide-moi à réfléchir : vous retrouvez la monnaie en trop après un achat. Quelle est la bonne conduite ?",
    reponse: "1) On pèse les valeurs en jeu avant de décider — l'éthique pratique est une pesée, pas une formule. 2) Situation : vous retrouvez la monnaie en trop après un achat. 3) Valeurs en tension : le petit profit facile contre l'équité. 4) Conduite retenue : signaler l'erreur au commerçant : la confiance vaut plus que quelques pièces. Donc : Signaler l'erreur au commerçant : la confiance vaut plus que quelques pièces.",
    theme: "ethique_pratique",
  },
  {
    motif: "Situation : un ami vous confie un secret que d'autres s'apprêtent à croire faux. Que faut-il faire, et pourquoi ?",
    reponse: "1) On pèse les valeurs en jeu avant de décider — l'éthique pratique est une pesée, pas une formule. 2) Situation : un ami vous confie un secret que d'autres s'apprêtent à croire faux. 3) Valeurs en tension : la loyauté contre l'honnêteté envers les tiers. 4) Conduite retenue : garder le secret mais aider l'ami à corriger l'information lui-même. Donc : Garder le secret mais aider l'ami à corriger l'information lui-même.",
    theme: "ethique_pratique",
  },
  {
    motif: "Dilemme : un ami vous confie un secret que d'autres s'apprêtent à croire faux. Quelles valeurs s'affrontent et quelle conduite retenir ?",
    reponse: "1) On pèse les valeurs en jeu avant de décider — l'éthique pratique est une pesée, pas une formule. 2) Situation : un ami vous confie un secret que d'autres s'apprêtent à croire faux. 3) Valeurs en tension : la loyauté contre l'honnêteté envers les tiers. 4) Conduite retenue : garder le secret mais aider l'ami à corriger l'information lui-même. Donc : Garder le secret mais aider l'ami à corriger l'information lui-même.",
    theme: "ethique_pratique",
  },
  {
    motif: "Aide-moi à réfléchir : un ami vous confie un secret que d'autres s'apprêtent à croire faux. Quelle est la bonne conduite ?",
    reponse: "1) On pèse les valeurs en jeu avant de décider — l'éthique pratique est une pesée, pas une formule. 2) Situation : un ami vous confie un secret que d'autres s'apprêtent à croire faux. 3) Valeurs en tension : la loyauté contre l'honnêteté envers les tiers. 4) Conduite retenue : garder le secret mais aider l'ami à corriger l'information lui-même. Donc : Garder le secret mais aider l'ami à corriger l'information lui-même.",
    theme: "ethique_pratique",
  },
  {
    motif: "Situation : on vous promet une sortie, un imprévu plus important survient. Que faut-il faire, et pourquoi ?",
    reponse: "1) On pèse les valeurs en jeu avant de décider — l'éthique pratique est une pesée, pas une formule. 2) Situation : on vous promet une sortie, un imprévu plus important survient. 3) Valeurs en tension : tenir sa parole contre une nécessité réelle. 4) Conduite retenue : prévenir immédiatement, s'excuser sincèrement et reprogrammer — l'annulation honnête vaut mieux que la présence de mauvaise foi. Donc : Prévenir immédiatement, s'excuser sincèrement et reprogrammer — l'annulation honnête vaut mieux que la présence de mauvaise foi.",
    theme: "ethique_pratique",
  },
  {
    motif: "Dilemme : on vous promet une sortie, un imprévu plus important survient. Quelles valeurs s'affrontent et quelle conduite retenir ?",
    reponse: "1) On pèse les valeurs en jeu avant de décider — l'éthique pratique est une pesée, pas une formule. 2) Situation : on vous promet une sortie, un imprévu plus important survient. 3) Valeurs en tension : tenir sa parole contre une nécessité réelle. 4) Conduite retenue : prévenir immédiatement, s'excuser sincèrement et reprogrammer — l'annulation honnête vaut mieux que la présence de mauvaise foi. Donc : Prévenir immédiatement, s'excuser sincèrement et reprogrammer — l'annulation honnête vaut mieux que la présence de mauvaise foi.",
    theme: "ethique_pratique",
  },
  {
    motif: "Aide-moi à réfléchir : on vous promet une sortie, un imprévu plus important survient. Quelle est la bonne conduite ?",
    reponse: "1) On pèse les valeurs en jeu avant de décider — l'éthique pratique est une pesée, pas une formule. 2) Situation : on vous promet une sortie, un imprévu plus important survient. 3) Valeurs en tension : tenir sa parole contre une nécessité réelle. 4) Conduite retenue : prévenir immédiatement, s'excuser sincèrement et reprogrammer — l'annulation honnête vaut mieux que la présence de mauvaise foi. Donc : Prévenir immédiatement, s'excuser sincèrement et reprogrammer — l'annulation honnête vaut mieux que la présence de mauvaise foi.",
    theme: "ethique_pratique",
  },
  {
    motif: "Alice est assis à gauche de Bernard, qui est assis à gauche de Camille. Qui est au milieu ?",
    reponse: "1) On reconstruit mentalement la chaîne de gauche à droite. 2) Ordre : Alice, puis Bernard, puis Camille. 3) Le milieu de la chaîne de trois est le deuxième. Donc : Bernard est au milieu.",
    theme: "spatial",
  },
  {
    motif: "Petit casse-tête : Alice est assis à gauche de Bernard, qui est assis à gauche de Camille. Qui est au milieu ?",
    reponse: "1) On reconstruit mentalement la chaîne de gauche à droite. 2) Ordre : Alice, puis Bernard, puis Camille. 3) Le milieu de la chaîne de trois est le deuxième. Donc : Bernard est au milieu.",
    theme: "spatial",
  },
  {
    motif: "Alice est assis à gauche de Bernard, qui est assis à gauche de Camille. Qui est au milieu ? Raisonnez étape par étape.",
    reponse: "1) On reconstruit mentalement la chaîne de gauche à droite. 2) Ordre : Alice, puis Bernard, puis Camille. 3) Le milieu de la chaîne de trois est le deuxième. Donc : Bernard est au milieu.",
    theme: "spatial",
  },
  {
    motif: "Exercice de position : Alice est assis à gauche de Bernard, qui est assis à gauche de Camille. Qui est au milieu ?",
    reponse: "1) On reconstruit mentalement la chaîne de gauche à droite. 2) Ordre : Alice, puis Bernard, puis Camille. 3) Le milieu de la chaîne de trois est le deuxième. Donc : Bernard est au milieu.",
    theme: "spatial",
  },
  {
    motif: "Dans une file, Bernard se tient juste devant Alice, et Camille se tient juste devant Bernard. Qui est en tête de file ?",
    reponse: "1) On reconstruit la file depuis la queue. 2) Au fond : Alice. Juste devant lui : Bernard. Devant Bernard : Camille. 3) Le premier est celui devant qui personne ne se trouve. Donc : Camille est en tête de file.",
    theme: "spatial",
  },
  {
    motif: "Petit casse-tête : Dans une file, Bernard se tient juste devant Alice, et Camille se tient juste devant Bernard. Qui est en tête de file ?",
    reponse: "1) On reconstruit la file depuis la queue. 2) Au fond : Alice. Juste devant lui : Bernard. Devant Bernard : Camille. 3) Le premier est celui devant qui personne ne se trouve. Donc : Camille est en tête de file.",
    theme: "spatial",
  },
  {
    motif: "Dans une file, Bernard se tient juste devant Alice, et Camille se tient juste devant Bernard. Qui est en tête de file ? Raisonnez étape par étape.",
    reponse: "1) On reconstruit la file depuis la queue. 2) Au fond : Alice. Juste devant lui : Bernard. Devant Bernard : Camille. 3) Le premier est celui devant qui personne ne se trouve. Donc : Camille est en tête de file.",
    theme: "spatial",
  },
  {
    motif: "Exercice de position : Dans une file, Bernard se tient juste devant Alice, et Camille se tient juste devant Bernard. Qui est en tête de file ?",
    reponse: "1) On reconstruit la file depuis la queue. 2) Au fond : Alice. Juste devant lui : Bernard. Devant Bernard : Camille. 3) Le premier est celui devant qui personne ne se trouve. Donc : Camille est en tête de file.",
    theme: "spatial",
  },
  {
    motif: "Alice est à droite de Bernard, et Camille est à droite de Alice. Qui est le plus à droite ?",
    reponse: "1) On aligne de gauche à droite en suivant les indications. 2) Ordre de gauche à droite : Bernard, Alice, Camille. 3) Le plus à droite est le dernier de la chaîne. Donc : Camille est le plus à droite.",
    theme: "spatial",
  },
  {
    motif: "Petit casse-tête : Alice est à droite de Bernard, et Camille est à droite de Alice. Qui est le plus à droite ?",
    reponse: "1) On aligne de gauche à droite en suivant les indications. 2) Ordre de gauche à droite : Bernard, Alice, Camille. 3) Le plus à droite est le dernier de la chaîne. Donc : Camille est le plus à droite.",
    theme: "spatial",
  },
  {
    motif: "Alice est à droite de Bernard, et Camille est à droite de Alice. Qui est le plus à droite ? Raisonnez étape par étape.",
    reponse: "1) On aligne de gauche à droite en suivant les indications. 2) Ordre de gauche à droite : Bernard, Alice, Camille. 3) Le plus à droite est le dernier de la chaîne. Donc : Camille est le plus à droite.",
    theme: "spatial",
  },
  {
    motif: "Exercice de position : Alice est à droite de Bernard, et Camille est à droite de Alice. Qui est le plus à droite ?",
    reponse: "1) On aligne de gauche à droite en suivant les indications. 2) Ordre de gauche à droite : Bernard, Alice, Camille. 3) Le plus à droite est le dernier de la chaîne. Donc : Camille est le plus à droite.",
    theme: "spatial",
  },
  {
    motif: "Le train part à 0 h 00 et le trajet dure 0 h 15. À quelle heure arrive-t-il ?",
    reponse: "1) On additionne l'heure de départ et la durée, minute par minute. 2) Départ : 0 h 00. Durée : 0 h 15. 3) Total depuis minuit : 15 minutes. 4) Converti : 0 h 15. Donc : Arrivée à 0 h 15.",
    theme: "temporel",
  },
  {
    motif: "Départ : 0 h 00. Durée : 0 h 15. Calculez l'heure d'arrivée.",
    reponse: "1) On additionne l'heure de départ et la durée, minute par minute. 2) Départ : 0 h 00. Durée : 0 h 15. 3) Total depuis minuit : 15 minutes. 4) Converti : 0 h 15. Donc : Arrivée à 0 h 15.",
    theme: "temporel",
  },
  {
    motif: "On part à 0 h 00 pour un trajet de 0 h 15. Heure d'arrivée ?",
    reponse: "1) On additionne l'heure de départ et la durée, minute par minute. 2) Départ : 0 h 00. Durée : 0 h 15. 3) Total depuis minuit : 15 minutes. 4) Converti : 0 h 15. Donc : Arrivée à 0 h 15.",
    theme: "temporel",
  },
  {
    motif: "Question d'horloge : départ 0 h 00, plus 0 h 15 de route. Quand arrive-t-on ?",
    reponse: "1) On additionne l'heure de départ et la durée, minute par minute. 2) Départ : 0 h 00. Durée : 0 h 15. 3) Total depuis minuit : 15 minutes. 4) Converti : 0 h 15. Donc : Arrivée à 0 h 15.",
    theme: "temporel",
  },
  {
    motif: "Le train part à 0 h 05 et le trajet dure 0 h 15. À quelle heure arrive-t-il ?",
    reponse: "1) On additionne l'heure de départ et la durée, minute par minute. 2) Départ : 0 h 05. Durée : 0 h 15. 3) Total depuis minuit : 20 minutes. 4) Converti : 0 h 20. Donc : Arrivée à 0 h 20.",
    theme: "temporel",
  },
  {
    motif: "Départ : 0 h 05. Durée : 0 h 15. Calculez l'heure d'arrivée.",
    reponse: "1) On additionne l'heure de départ et la durée, minute par minute. 2) Départ : 0 h 05. Durée : 0 h 15. 3) Total depuis minuit : 20 minutes. 4) Converti : 0 h 20. Donc : Arrivée à 0 h 20.",
    theme: "temporel",
  },
  {
    motif: "On part à 0 h 05 pour un trajet de 0 h 15. Heure d'arrivée ?",
    reponse: "1) On additionne l'heure de départ et la durée, minute par minute. 2) Départ : 0 h 05. Durée : 0 h 15. 3) Total depuis minuit : 20 minutes. 4) Converti : 0 h 20. Donc : Arrivée à 0 h 20.",
    theme: "temporel",
  },
  {
    motif: "Question d'horloge : départ 0 h 05, plus 0 h 15 de route. Quand arrive-t-on ?",
    reponse: "1) On additionne l'heure de départ et la durée, minute par minute. 2) Départ : 0 h 05. Durée : 0 h 15. 3) Total depuis minuit : 20 minutes. 4) Converti : 0 h 20. Donc : Arrivée à 0 h 20.",
    theme: "temporel",
  },
  {
    motif: "Le train part à 0 h 10 et le trajet dure 0 h 15. À quelle heure arrive-t-il ?",
    reponse: "1) On additionne l'heure de départ et la durée, minute par minute. 2) Départ : 0 h 10. Durée : 0 h 15. 3) Total depuis minuit : 25 minutes. 4) Converti : 0 h 25. Donc : Arrivée à 0 h 25.",
    theme: "temporel",
  },
  {
    motif: "Départ : 0 h 10. Durée : 0 h 15. Calculez l'heure d'arrivée.",
    reponse: "1) On additionne l'heure de départ et la durée, minute par minute. 2) Départ : 0 h 10. Durée : 0 h 15. 3) Total depuis minuit : 25 minutes. 4) Converti : 0 h 25. Donc : Arrivée à 0 h 25.",
    theme: "temporel",
  },
  {
    motif: "On part à 0 h 10 pour un trajet de 0 h 15. Heure d'arrivée ?",
    reponse: "1) On additionne l'heure de départ et la durée, minute par minute. 2) Départ : 0 h 10. Durée : 0 h 15. 3) Total depuis minuit : 25 minutes. 4) Converti : 0 h 25. Donc : Arrivée à 0 h 25.",
    theme: "temporel",
  },
  {
    motif: "Question d'horloge : départ 0 h 10, plus 0 h 15 de route. Quand arrive-t-on ?",
    reponse: "1) On additionne l'heure de départ et la durée, minute par minute. 2) Départ : 0 h 10. Durée : 0 h 15. 3) Total depuis minuit : 25 minutes. 4) Converti : 0 h 25. Donc : Arrivée à 0 h 25.",
    theme: "temporel",
  },
  {
    motif: "Question de réflexion : qu'est-ce qui distingue savoir et croire ?",
    reponse: "1) On observe l'esprit lui-même : c'est la métacognition. 2) Question : qu'est-ce qui distingue savoir et croire ? 3) Réponse : savoir suppose une justification vérifiable : on peut montrer comment on sait ; croire est une conviction qui peut être vraie ou fausse sans preuve encore. Donc : Savoir suppose une justification vérifiable : on peut montrer comment on sait ; croire est une conviction qui peut être vraie ou fausse sans preuve encore.",
    theme: "metacognition",
  },
  {
    motif: "Qu'est-ce qui distingue savoir et croire ? — peux-tu expliquer comment l'esprit procède ?",
    reponse: "1) On observe l'esprit lui-même : c'est la métacognition. 2) Question : qu'est-ce qui distingue savoir et croire ? 3) Réponse : savoir suppose une justification vérifiable : on peut montrer comment on sait ; croire est une conviction qui peut être vraie ou fausse sans preuve encore. Donc : Savoir suppose une justification vérifiable : on peut montrer comment on sait ; croire est une conviction qui peut être vraie ou fausse sans preuve encore.",
    theme: "metacognition",
  },
  {
    motif: "On m'a demandé : qu'est-ce qui distingue savoir et croire ? — quelle est la réponse d'un esprit humain réfléchi ?",
    reponse: "1) On observe l'esprit lui-même : c'est la métacognition. 2) Question : qu'est-ce qui distingue savoir et croire ? 3) Réponse : savoir suppose une justification vérifiable : on peut montrer comment on sait ; croire est une conviction qui peut être vraie ou fausse sans preuve encore. Donc : Savoir suppose une justification vérifiable : on peut montrer comment on sait ; croire est une conviction qui peut être vraie ou fausse sans preuve encore.",
    theme: "metacognition",
  },
  {
    motif: "Question de réflexion : quand un mot est « sur le bout de la langue », que se passe-t-il ?",
    reponse: "1) On observe l'esprit lui-même : c'est la métacognition. 2) Question : quand un mot est « sur le bout de la langue », que se passe-t-il ? 3) Réponse : la mémoire du sens est là, pas celle du son ; on accède souvent au mot en le décrivant ou en passant par le contexte où on l'a entendu. Donc : La mémoire du sens est là, pas celle du son ; on accède souvent au mot en le décrivant ou en passant par le contexte où on l'a entendu.",
    theme: "metacognition",
  },
  {
    motif: "Quand un mot est « sur le bout de la langue », que se passe-t-il ? — peux-tu expliquer comment l'esprit procède ?",
    reponse: "1) On observe l'esprit lui-même : c'est la métacognition. 2) Question : quand un mot est « sur le bout de la langue », que se passe-t-il ? 3) Réponse : la mémoire du sens est là, pas celle du son ; on accède souvent au mot en le décrivant ou en passant par le contexte où on l'a entendu. Donc : La mémoire du sens est là, pas celle du son ; on accède souvent au mot en le décrivant ou en passant par le contexte où on l'a entendu.",
    theme: "metacognition",
  },
  {
    motif: "On m'a demandé : quand un mot est « sur le bout de la langue », que se passe-t-il ? — quelle est la réponse d'un esprit humain réfléchi ?",
    reponse: "1) On observe l'esprit lui-même : c'est la métacognition. 2) Question : quand un mot est « sur le bout de la langue », que se passe-t-il ? 3) Réponse : la mémoire du sens est là, pas celle du son ; on accède souvent au mot en le décrivant ou en passant par le contexte où on l'a entendu. Donc : La mémoire du sens est là, pas celle du son ; on accède souvent au mot en le décrivant ou en passant par le contexte où on l'a entendu.",
    theme: "metacognition",
  },
  {
    motif: "Question de réflexion : comment reconnaît-on qu'on s'est trompé ?",
    reponse: "1) On observe l'esprit lui-même : c'est la métacognition. 2) Question : comment reconnaît-on qu'on s'est trompé ? 3) Réponse : un résultat contredit une attente vérifiable : on refait le calcul, on cherche la faille, et l'erreur se localise — l'inconfort ressenti est un vrai signal. Donc : Un résultat contredit une attente vérifiable : on refait le calcul, on cherche la faille, et l'erreur se localise — l'inconfort ressenti est un vrai signal.",
    theme: "metacognition",
  },
  {
    motif: "Comment reconnaît-on qu'on s'est trompé ? — peux-tu expliquer comment l'esprit procède ?",
    reponse: "1) On observe l'esprit lui-même : c'est la métacognition. 2) Question : comment reconnaît-on qu'on s'est trompé ? 3) Réponse : un résultat contredit une attente vérifiable : on refait le calcul, on cherche la faille, et l'erreur se localise — l'inconfort ressenti est un vrai signal. Donc : Un résultat contredit une attente vérifiable : on refait le calcul, on cherche la faille, et l'erreur se localise — l'inconfort ressenti est un vrai signal.",
    theme: "metacognition",
  },
  {
    motif: "On m'a demandé : comment reconnaît-on qu'on s'est trompé ? — quelle est la réponse d'un esprit humain réfléchi ?",
    reponse: "1) On observe l'esprit lui-même : c'est la métacognition. 2) Question : comment reconnaît-on qu'on s'est trompé ? 3) Réponse : un résultat contredit une attente vérifiable : on refait le calcul, on cherche la faille, et l'erreur se localise — l'inconfort ressenti est un vrai signal. Donc : Un résultat contredit une attente vérifiable : on refait le calcul, on cherche la faille, et l'erreur se localise — l'inconfort ressenti est un vrai signal.",
    theme: "metacognition",
  },
  {
    motif: "Question de réflexion : comment planifie-t-on mentalement une tâche ?",
    reponse: "1) On observe l'esprit lui-même : c'est la métacognition. 2) Question : comment planifie-t-on mentalement une tâche ? 3) Réponse : on décompose l'objectif en sous-étapes, on estime la durée de chacune, on repère ce qui bloque, puis on ordonne — la planification est une répétition intérieure de l'action. Donc : On décompose l'objectif en sous-étapes, on estime la durée de chacune, on repère ce qui bloque, puis on ordonne — la planification est une répétition intérieure de l'action.",
    theme: "metacognition",
  },
  {
    motif: "Comment planifie-t-on mentalement une tâche ? — peux-tu expliquer comment l'esprit procède ?",
    reponse: "1) On observe l'esprit lui-même : c'est la métacognition. 2) Question : comment planifie-t-on mentalement une tâche ? 3) Réponse : on décompose l'objectif en sous-étapes, on estime la durée de chacune, on repère ce qui bloque, puis on ordonne — la planification est une répétition intérieure de l'action. Donc : On décompose l'objectif en sous-étapes, on estime la durée de chacune, on repère ce qui bloque, puis on ordonne — la planification est une répétition intérieure de l'action.",
    theme: "metacognition",
  },
  {
    motif: "On m'a demandé : comment planifie-t-on mentalement une tâche ? — quelle est la réponse d'un esprit humain réfléchi ?",
    reponse: "1) On observe l'esprit lui-même : c'est la métacognition. 2) Question : comment planifie-t-on mentalement une tâche ? 3) Réponse : on décompose l'objectif en sous-étapes, on estime la durée de chacune, on repère ce qui bloque, puis on ordonne — la planification est une répétition intérieure de l'action. Donc : On décompose l'objectif en sous-étapes, on estime la durée de chacune, on repère ce qui bloque, puis on ordonne — la planification est une répétition intérieure de l'action.",
    theme: "metacognition",
  },
  {
    motif: "Un souci du quotidien : le vélo fait un bruit de frottement à chaque tour de roue. Comment s'y prendre ?",
    reponse: "1) On résout par méthode, pas par hasard : comprendre, isoler, tester. 2) Problème : le vélo fait un bruit de frottement à chaque tour de roue. 3) Démarche : isoler la variable : lever la roue et la faire tourner à la main, écouter chaque point (frein, garde-boue, moyeu) ; resserrer ou régler ce qui touche, une hypothèse à la fois. Donc : Isoler la variable : lever la roue et la faire tourner à la main, écouter chaque point (frein, garde-boue, moyeu) ; resserrer ou régler ce qui touche, une hypothèse à la fois.",
    theme: "resolution_probleme",
  },
  {
    motif: "Le vélo fait un bruit de frottement à chaque tour de roue. Quelle méthode de résolution appliquer ?",
    reponse: "1) On résout par méthode, pas par hasard : comprendre, isoler, tester. 2) Problème : le vélo fait un bruit de frottement à chaque tour de roue. 3) Démarche : isoler la variable : lever la roue et la faire tourner à la main, écouter chaque point (frein, garde-boue, moyeu) ; resserrer ou régler ce qui touche, une hypothèse à la fois. Donc : Isoler la variable : lever la roue et la faire tourner à la main, écouter chaque point (frein, garde-boue, moyeu) ; resserrer ou régler ce qui touche, une hypothèse à la fois.",
    theme: "resolution_probleme",
  },
  {
    motif: "Aide-moi : le vélo fait un bruit de frottement à chaque tour de roue. Quelle démarche ?",
    reponse: "1) On résout par méthode, pas par hasard : comprendre, isoler, tester. 2) Problème : le vélo fait un bruit de frottement à chaque tour de roue. 3) Démarche : isoler la variable : lever la roue et la faire tourner à la main, écouter chaque point (frein, garde-boue, moyeu) ; resserrer ou régler ce qui touche, une hypothèse à la fois. Donc : Isoler la variable : lever la roue et la faire tourner à la main, écouter chaque point (frein, garde-boue, moyeu) ; resserrer ou régler ce qui touche, une hypothèse à la fois.",
    theme: "resolution_probleme",
  },
  {
    motif: "Un souci du quotidien : le robinet goutte même fermé. Comment s'y prendre ?",
    reponse: "1) On résout par méthode, pas par hasard : comprendre, isoler, tester. 2) Problème : le robinet goutte même fermé. 3) Démarche : comprendre la chaîne : le goutte-à-goutte vient d'un joint usé ; démonter la tête, remplacer le joint, remonter — on répare la cause, pas le bruit. Donc : Comprendre la chaîne : le goutte-à-goutte vient d'un joint usé ; démonter la tête, remplacer le joint, remonter — on répare la cause, pas le bruit.",
    theme: "resolution_probleme",
  },
  {
    motif: "Le robinet goutte même fermé. Quelle méthode de résolution appliquer ?",
    reponse: "1) On résout par méthode, pas par hasard : comprendre, isoler, tester. 2) Problème : le robinet goutte même fermé. 3) Démarche : comprendre la chaîne : le goutte-à-goutte vient d'un joint usé ; démonter la tête, remplacer le joint, remonter — on répare la cause, pas le bruit. Donc : Comprendre la chaîne : le goutte-à-goutte vient d'un joint usé ; démonter la tête, remplacer le joint, remonter — on répare la cause, pas le bruit.",
    theme: "resolution_probleme",
  },
  {
    motif: "Aide-moi : le robinet goutte même fermé. Quelle démarche ?",
    reponse: "1) On résout par méthode, pas par hasard : comprendre, isoler, tester. 2) Problème : le robinet goutte même fermé. 3) Démarche : comprendre la chaîne : le goutte-à-goutte vient d'un joint usé ; démonter la tête, remplacer le joint, remonter — on répare la cause, pas le bruit. Donc : Comprendre la chaîne : le goutte-à-goutte vient d'un joint usé ; démonter la tête, remplacer le joint, remonter — on répare la cause, pas le bruit.",
    theme: "resolution_probleme",
  },
  {
    motif: "Un souci du quotidien : l'imprimante sort une page à l'envers ou dans le mauvais sens. Comment s'y prendre ?",
    reponse: "1) On résout par méthode, pas par hasard : comprendre, isoler, tester. 2) Problème : l'imprimante sort une page à l'envers ou dans le mauvais sens. 3) Démarche : comparer ce qui est attendu et obtenu (contenu, orientation, ordre des pages), puis vérifier les réglages un à un : le problème est presque toujours un réglage, pas la machine. Donc : Comparer ce qui est attendu et obtenu (contenu, orientation, ordre des pages), puis vérifier les réglages un à un : le problème est presque toujours un réglage, pas la machine.",
    theme: "resolution_probleme",
  },
  {
    motif: "L'imprimante sort une page à l'envers ou dans le mauvais sens. Quelle méthode de résolution appliquer ?",
    reponse: "1) On résout par méthode, pas par hasard : comprendre, isoler, tester. 2) Problème : l'imprimante sort une page à l'envers ou dans le mauvais sens. 3) Démarche : comparer ce qui est attendu et obtenu (contenu, orientation, ordre des pages), puis vérifier les réglages un à un : le problème est presque toujours un réglage, pas la machine. Donc : Comparer ce qui est attendu et obtenu (contenu, orientation, ordre des pages), puis vérifier les réglages un à un : le problème est presque toujours un réglage, pas la machine.",
    theme: "resolution_probleme",
  },
  {
    motif: "Aide-moi : l'imprimante sort une page à l'envers ou dans le mauvais sens. Quelle démarche ?",
    reponse: "1) On résout par méthode, pas par hasard : comprendre, isoler, tester. 2) Problème : l'imprimante sort une page à l'envers ou dans le mauvais sens. 3) Démarche : comparer ce qui est attendu et obtenu (contenu, orientation, ordre des pages), puis vérifier les réglages un à un : le problème est presque toujours un réglage, pas la machine. Donc : Comparer ce qui est attendu et obtenu (contenu, orientation, ordre des pages), puis vérifier les réglages un à un : le problème est presque toujours un réglage, pas la machine.",
    theme: "resolution_probleme",
  },
  {
    motif: "Un souci du quotidien : le programme ne compile pas après une modification. Comment s'y prendre ?",
    reponse: "1) On résout par méthode, pas par hasard : comprendre, isoler, tester. 2) Problème : le programme ne compile pas après une modification. 3) Démarche : lire le premier message d'erreur (pas le dernier), revenir à la dernière version qui marchait, réintroduire les changements par petits pas : on isole la cause au lieu de tout deviner. Donc : Lire le premier message d'erreur (pas le dernier), revenir à la dernière version qui marchait, réintroduire les changements par petits pas : on isole la cause au lieu de tout deviner.",
    theme: "resolution_probleme",
  },
  {
    motif: "Le programme ne compile pas après une modification. Quelle méthode de résolution appliquer ?",
    reponse: "1) On résout par méthode, pas par hasard : comprendre, isoler, tester. 2) Problème : le programme ne compile pas après une modification. 3) Démarche : lire le premier message d'erreur (pas le dernier), revenir à la dernière version qui marchait, réintroduire les changements par petits pas : on isole la cause au lieu de tout deviner. Donc : Lire le premier message d'erreur (pas le dernier), revenir à la dernière version qui marchait, réintroduire les changements par petits pas : on isole la cause au lieu de tout deviner.",
    theme: "resolution_probleme",
  },
  {
    motif: "Aide-moi : le programme ne compile pas après une modification. Quelle démarche ?",
    reponse: "1) On résout par méthode, pas par hasard : comprendre, isoler, tester. 2) Problème : le programme ne compile pas après une modification. 3) Démarche : lire le premier message d'erreur (pas le dernier), revenir à la dernière version qui marchait, réintroduire les changements par petits pas : on isole la cause au lieu de tout deviner. Donc : Lire le premier message d'erreur (pas le dernier), revenir à la dernière version qui marchait, réintroduire les changements par petits pas : on isole la cause au lieu de tout deviner.",
    theme: "resolution_probleme",
  },
];
