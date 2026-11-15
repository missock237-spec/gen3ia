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
export { plafondsAuto, delaiInitialAutoMs, dureeAbsorptionMs, intervalleAbsorptionMs, intervalleMaitriseMs, type PlafondsAuto } from "./plafonds";
export {
  absorptionExpiree,
  bilanAutonomie,
  cloturerAbsorption,
  phaseDe,
  type VuePhase,
} from "./phases";
export { choisirDatasets, requeteDuCycle, REQUETES_OBJECTIF, type RechercheObjectif } from "./catalogue";
export {
  appliquerBilanDomaine,
  blocMaitriseDe,
  blocMaitriseNeuf,
  CATALOGUE_MAITRISE,
  CATALOGUE_VERSION,
  choisirDomaineCible,
  domaineParId,
  domainesMaitrises,
  entrainerEtEvaluerDomaine,
  etatDomaineNeuf,
  evaluerRetentionCortex,
  maitriseComplete,
  regimeParDefaut,
  reponseCorrespond,
  separerValidation,
  UNITES_VALIDATION_MIN,
  type DomaineMaitrise,
  type ResultatEntrainementDomaine,
  type ResultatRetention,
} from "./maitrise";
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
  BilanAutonomie,
  BlocMaitrise,
  ClientHubAuto,
  DatasetChoisi,
  EtatAutoApprentissage,
  EtatDomaineMaitrise,
  EvaluationMaitrise,
  HubSource,
  ObjectifAuto,
  PhaseVie,
  RapportCycleAuto,
  RapportHubCycle,
  RapportIntentionCycle,
  RapportLangageCycle,
  RapportMaitrise,
  RegimeAuto,
} from "./types";
