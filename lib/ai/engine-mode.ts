/**
 * MODE MOTEUR IA — aiguillage central entre les IA EXTERNES du projet et le
 * moteur NEURONAL Gen3 (SNN interne, lib/neural/).
 *
 * RÈGLE : `GEN3IA_AI_ENGINE=neural` (lu À L'APPEL, jamais au chargement du
 * module — cf. convention du dépôt pour effet sans redéploiement) active le
 * mode neuronal : les intégrations IA externes (LLM distants, images Agnes/HF,
 * voix ElevenLabs/Bland, vision live, Jules, 21st.dev, recherche web,
 * embeddings HF) sont TOUTES désactivées — leur code est CONSERVÉ intact,
 * elles refusent simplement de s'exécuter avec un message explicite.
 *
 * Toute autre valeur (ou variable absente) : comportement historique
 * inchangé (routeur multi-fournisseurs externe).
 *
 * Cette désactivation est la condition posée par l'utilisateur pour tester
 * le système neuronal Gen3 de manière optimale, sans interférence.
 */

/** Variable d'environnement du mode moteur. */
export const ENV_GEN3IA_AI_ENGINE = "GEN3IA_AI_ENGINE";

/** Valeur activant le moteur neuronal interne. */
export const NEURAL_ENGINE_VALUE = "neural";

/**
 * Vrai si le moteur neuronal Gen3 (SNN) est actif — lu à CHAQUE appel
 * (pattern du dépôt : effet immédiat au changement d'env, sans rebuild).
 */
export function isNeuralEngineActive(): boolean {
  return process.env[ENV_GEN3IA_AI_ENGINE] === NEURAL_ENGINE_VALUE;
}

/**
 * Erreur type levée par toute intégration IA externe désactivée en mode
 * neuronal — message explicite pour l'utilisateur et les logs.
 */
export class MoteurExterneDesactiveError extends Error {
  constructor(service: string) {
    super(
      `[MODE NEURONAL] Le service externe « ${service} » est désactivé ` +
        `(GEN3IA_AI_ENGINE=${NEURAL_ENGINE_VALUE}) : le moteur neuronal ` +
        `Gen3 (SNN) est actif et remplace les IA externes pendant la phase ` +
        `de test.`,
    );
    this.name = "MoteurExterneDesactiveError";
  }
}

/**
 * Garde d'entrée pour une intégration IA externe : lève immédiatement
 * `MoteurExterneDesactiveError` si le mode neuronal est actif.
 */
export function refuserSiMoteurNeuralActif(service: string): void {
  if (isNeuralEngineActive()) {
    throw new MoteurExterneDesactiveError(service);
  }
}
