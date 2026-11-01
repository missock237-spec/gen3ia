import { NextResponse } from "next/server";

import { PROFILS_ENERGIE, VAR_ENV_PROFIL_ENERGIE } from "@/lib/neural/core/v2/energie";
import { profilEnergieActif } from "@/lib/neural/core/v2/profil-production";
import { lireCompteurEnergieProcess } from "@/lib/neural/core/v2/compteur-energie-process";
import { lireCompteurPontVocation } from "@/lib/neural/compteur-pont-vocation";
import {
  fichierCompteurs,
  lireModePersistanceCompteurs,
  VAR_ENV_FICHIER_COMPTEURS,
} from "@/lib/neural/persistance-compteurs";

export const dynamic = "force-dynamic";

/**
 * GET /api/energie — SOBRIÉTÉ ÉNERGÉTIQUE DÉCLARÉE (it.74, candidat №1
 * déclaré it.73 §7.1) : statut public du profil d'énergie actif et MESURE
 * réelle de la réduction de charge serveur.
 *
 * Réponse : { profil, varEnv, compteur, pontVocation, honnetete }
 *  - profil   : profil actif (« plein » historique / « eco » / « telephone »),
 *               SA SOURCE (variable d'environnement locale, fichier versionné
 *               assets/config/profil-energie-production.json, ou repli
 *               honnête) et sa description déclarée (module pur it.73) ;
 *  - compteur : fenêtres neuronales EXÉCUTÉES vs ÉVITÉES depuis le
 *               démarrage du processus — sommes d'entiers mesurés (jamais
 *               estimées), réinitialisées à chaque redéploiement ;
 *  - pontVocation : it.75 — questions du cadre RÉPONDUES par l'endpoint
 *               public /api/neural/questions (testeur /vocation) et refus
 *               honnêtes hors cadre. Ces réponses n'allument JAMAIS de
 *               fenêtre moteur — PAR CONSTRUCTION de l'endpoint, quel que
 *               soit le profil (zéro fenêtre, zéro RPIA, zéro cycle) ; le
 *               périmètre est disjoint du compteur du moteur (chat /
 *               génération) et les deux sommes s'additionnent sans double
 *               comptage ;
 *  - honnetete : la règle structurante (aucune économie silencieuse — le
 *               profil « plein » est le comportement historique bit à bit ;
 *               « eco »/« telephone » répondent par le MÊME pont lexical,
 *               même texte, testé A/B it.73 ; hors cadre = chemin complet) ;
 *  - persistanceCompteurs : it.78 — les sommes persistent sur disque et
 *               CONTINUENT à travers les redéploiements ; le mode constaté
 *               (« fichier » = écritures réussies, « memoire » = écriture
 *               impossible, repli déclaré) est publié ici, jamais avalé.
 *
 * Public et sans donnée sensible (même convention que /api/health) — c'est
 * la mesure publique de la demande propriétaire : « diminuer la
 * consommation d'énergie de gen3 tout en gardant sa qualité de réponse ».
 * ULTRA-LÉGER : deux lectures de mémoire + une lecture JSON disque (~1 Ko).
 * JAMAIS CACHÉE (no-store) — le compteur doit refléter l'instant.
 */
export async function GET() {
  const actif = profilEnergieActif();
  const compteur = lireCompteurEnergieProcess();
  const pontVocation = lireCompteurPontVocation();
  const modePersistance = lireModePersistanceCompteurs();

  return NextResponse.json(
    {
      profil: {
        actif: actif.profil,
        source: actif.source,
        description: PROFILS_ENERGIE[actif.profil].description,
      },
      varEnv: VAR_ENV_PROFIL_ENERGIE,
      compteur,
      pontVocation: {
        ...pontVocation,
        perimetre:
          "endpoint public /api/neural/questions (testeur /vocation) — réponses servies SANS fenêtre moteur, par construction, quel que soit le profil ; disjoint du compteur du moteur (chat/génération)",
      },
      honnetete: {
        regle:
          "aucune économie silencieuse — « plein » = comportement historique bit à bit (défaut) ; « eco »/« telephone » = économies déclarées et mesurées",
        qualite:
          "les questions du cadre d'apprentissage sont répondues par le MÊME pont lexical que la production (même texte, testé A/B it.73) ; hors cadre = chemin historique complet inchangé",
        mesure:
          "compteurs cumulés persistés sur disque (it.78 — continuent à travers les redéploiements) — fenêtres exécutées vs évitées (moteur) et réponses/refus du pont public, sommes d'entiers mesurés",
        priorite:
          "variable d'environnement (opérateur local) > fichier versionné (dépôt) > « plein »",
      },
      persistanceCompteurs: {
        mode: modePersistance ?? "initial",
        fichier: fichierCompteurs(),
        varEnv: VAR_ENV_FICHIER_COMPTEURS,
        regle:
          "sommes persistées en écriture atomique (tmp + rename) ; mode « fichier » = les compteurs continuent à travers les redéploiements ; mode « memoire » = écriture impossible, repli mémoire DÉCLARÉ (les compteurs repartent alors de zéro au redéploiement) ; « initial » = aucune écriture constatée depuis ce démarrage",
      },
    },
    {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
