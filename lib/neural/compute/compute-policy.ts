/**
 * COMPUTE POLICY — LA RÈGLE FONDAMENTALE mission (Phase 2) :
 * « Le système ne doit jamais choisir WebGPU uniquement parce qu'il est
 * disponible. Il doit déterminer si son utilisation est réellement
 * avantageuse pour la tâche concernée. »
 *
 * Décision DÉTERMINISTE sur facteurs mesurables (testable sans GPU) :
 *  - taille de la tâche (éléments indépendants vs seuil de transfert) ;
 *  - coût des transferts CPU/GPU (octets in+out vs travail par élément) ;
 *  - mémoire nécessaire vs limites déclarées ;
 *  - état du matériel (détection honnête) ;
 *  - profil énergétique (ECO/MOBILE favorisent le CPU, PERFORMANCE/SERVER
 *    autorisent le GPU plus tôt) ;
 *  - famille d'opération (neuronal = CPU par nature — déterminisme Gen3).
 */

import { SEUILS_CALCUL, type CapacitesMateriel, type DecisionCalcul, type FamilleCalcul, type ProfilEnergie, type TacheCalcul } from "./compute-types";

/** Multiplicateur du seuil GPU selon le profil (ECO/MOBILE → plus exigeant). */
const FACTEUR_SEUIL_PROFIL: Record<ProfilEnergie, number> = {
  ECO: 4,
  MOBILE: 4,
  BALANCED: 1,
  PERFORMANCE: 0.5,
  SERVER: 1,
};

/** Coûts énergétiques RELATIFS (estimation honnête, jamais présentée comme mesure). */
function estimerCouts(tache: TacheCalcul): { cpu: number; gpu: number } {
  // CPU : travail proportionnel aux éléments (coût unitaire de référence 1).
  const cpu = tache.elements;
  // GPU : coût fixe de transfert (aller/retour) + travail parallèle
  // (rapport travail/élément selon la famille) + coût d'usage du GPU.
  const transfert = tache.octetsEntree + tache.octetsSortie;
  const ratioParallele: Record<FamilleCalcul, number> = {
    ondulatoire: 12,
    matriciel: 16,
    elementaire: 8,
    reduction: 6,
    multimodal: 10,
    generique: 8,
    neuronal: 1,
  };
  const gpu = Math.round(transfert / 64) + Math.max(1, Math.round(tache.elements / ratioParallele[tache.famille])) + 32;
  return { cpu, gpu };
}

/**
 * Évalue une tâche et retourne la décision MOTIVÉE. Ne lève jamais :
 * sans GPU ou en cas de doute → CPU avec la raison explicite.
 */
export function evaluerTache(
  tache: TacheCalcul,
  capacites: CapacitesMateriel,
  profil: ProfilEnergie = "BALANCED",
): DecisionCalcul {
  const { cpu, gpu } = estimerCouts(tache);
  const facteurs = {
    elements: tache.elements,
    octetsTransfert: tache.octetsEntree + tache.octetsSortie,
    seuilElements: SEUILS_CALCUL.elementsMinGpu,
    coutEstimeCpu: cpu,
    coutEstimeGpu: gpu,
  };

  // 1) Opérations CPU par nature (déterminisme Gen3, graphes clairsemés).
  if (tache.famille === "neuronal") {
    return { moteur: "cpu", raison: `famille « neuronal » : séquentiel + déterminisme Gen3 (horloge virtuelle, graphe clairsemé) — CPU par nature (audit Phase 1)`, facteurs };
  }

  // 2) État du matériel — sans WebGPU réel : CPU, jamais de fiction.
  if (!capacites.webgpuDisponible) {
    return { moteur: "cpu", raison: `WebGPU indisponible (${capacites.raisonIndisponibilite ?? "raison inconnue"}) — CPU actif`, facteurs };
  }

  // 3) Trop petite : le transfert coûte plus que le calcul.
  const seuil = Math.round(SEUILS_CALCUL.elementsMinGpu * FACTEUR_SEUIL_PROFIL[profil]);
  if (tache.elements < seuil) {
    return { moteur: "cpu", raison: `tâche trop petite (${tache.elements} éléments < seuil ${seuil} au profil ${profil}) : coût de transfert CPU↔GPU supérieur au gain`, facteurs };
  }

  // 4) Transfert dominant (grosses entrées/sorties, travail léger).
  const ratio = (tache.octetsEntree + tache.octetsSortie) / Math.max(1, tache.elements * 4);
  if (ratio > SEUILS_CALCUL.ratioTransfertMax) {
    return { moteur: "cpu", raison: `transfert dominant (${Math.round(ratio)} octets/élément > ${SEUILS_CALCUL.ratioTransfertMax}) : CPU préféré`, facteurs };
  }

  // 5) Mémoire : au-delà de la prudence ou de la limite déclarée → CPU.
  if (tache.memoireOctets > SEUILS_CALCUL.memoirePrudenceOctets) {
    return { moteur: "cpu", raison: `mémoire GPU demandée (${Math.round(tache.memoireOctets / 1024 / 1024)} Mo) au-delà de la prudence (${Math.round(SEUILS_CALCUL.memoirePrudenceOctets / 1024 / 1024)} Mo) — CPU`, facteurs };
  }
  if (capacites.maxBufferSizeOctets !== undefined && tache.memoireOctets > capacites.maxBufferSizeOctets) {
    return { moteur: "cpu", raison: `mémoire GPU demandée (${tache.memoireOctets} o) > maxBufferSize déclaré (${capacites.maxBufferSizeOctets} o) — CPU`, facteurs };
  }

  // 6) Décision finale par coût estimé : GPU si strictement avantageux.
  if (gpu < cpu) {
    const moteur: DecisionCalcul["moteur"] = tache.famille === "ondulatoire" && tache.elements > seuil * 4 ? "hybride" : "webgpu";
    return {
      moteur,
      raison: `GPU avantageux : coût estimé GPU ${gpu} < CPU ${cpu} (${tache.elements} éléments, transfert ${facteurs.octetsTransfert} o, profil ${profil})`,
      facteurs,
    };
  }
  return { moteur: "cpu", raison: `CPU préféré : coût estimé GPU ${gpu} ≥ CPU ${cpu} — le GPU ne sert pas cette tâche`, facteurs };
}

/** Fusionne deux capacités (navigateur + sonde hardware ondes) sans invention. */
export function fusionnerCapacites(base: CapacitesMateriel, familleGpu?: string): CapacitesMateriel {
  return familleGpu ? { ...base, familleGpu } : base;
}
