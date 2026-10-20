import "server-only";

/**
 * FAÇADE DE L'AUTO-APPRENTISSAGE — un seul point d'entrée :
 *
 *  - `demarrerAutoApprentissage()` : appelé au boot (instrumentation.ts) —
 *    arme la boucle autonome (HF + Kaggle) ;
 *  - `executerCycleAuto()` : un cycle complet à la demande (API POST) ;
 *  - `lireEtatAuto()` : état persistant pour l'API GET et l'affichage.
 *
 * Les variables d'env (voir .env.example, section AUTO-APPRENTISSAGE) :
 *  - AUTO_APPRENTISSAGE=0 → boucle désactivée (l'API manuelle reste active) ;
 *  - AUTO_APPRENTISSAGE_DELAI_S / _INTERVALLE_MIN / plafonds → réglages.
 */

export {
  ETAT_AUTO_PATH,
  etatParDefaut,
  ecrireEtatAuto,
  lireEtatAuto,
  reduireEtat,
} from "./etat";
export { plafondsAuto, intervalleAutoMs, delaiInitialAutoMs, type PlafondsAuto } from "./plafonds";
export { choisirDatasets, requeteDuCycle, REQUETES_OBJECTIF, type RechercheObjectif } from "./catalogue";
export { ingesterDataset, lignesDepuisContenu, convertirPaire, convertirEchantillon, nettoyerTexte, type ApportDataset } from "./ingesteur";
export { appliquerEntrainementAuto, type ResultatEntrainementAuto } from "./entraineur-auto";
export {
  clientHubReel,
  cycleEnCours,
  demarrerAutoApprentissage,
  executerCycleAuto,
  type OptionsCycle,
  type OptionsDemarrage,
} from "./boucle";
export type {
  ClientHubAuto,
  DatasetChoisi,
  EtatAutoApprentissage,
  HubSource,
  ObjectifAuto,
  RapportCycleAuto,
  RapportHubCycle,
  RapportIntentionCycle,
  RapportLangageCycle,
} from "./types";
