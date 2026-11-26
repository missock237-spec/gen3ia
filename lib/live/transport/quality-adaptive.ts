/**
 * QUALITY ADAPTIVE — adaptation automatique de la qualité du flux (mission
 * LOT 2 : « Adapter automatiquement la qualité », « limitation de bande
 * passante » ; profils LOT 12). Règles DÉTERMINISTES sur les métriques
 * réelles fournies par getStats (RTT ms, perte %) : les mesures réelles sur
 * matériel sont de la Phase 13 (non validées en sandbox — déclaré).
 */

export type ProfilQualite = "ECO" | "BALANCED" | "PERFORMANCE" | "MOBILE";

export interface ParametresProfil {
  /** Débit vidéo max (bps) envoyé au sender.setParameters. */
  bitrateVideoBps: number;
  /** Débit audio max (bps). */
  bitrateAudioBps: number;
  /** Images par seconde cibles. */
  ips: number;
  /** Résolution cible (échelle relative de la piste). */
  echelleResolution: number;
}

const PROFILS: Record<ProfilQualite, ParametresProfil> = {
  ECO: { bitrateVideoBps: 300_000, bitrateAudioBps: 16_000, ips: 12, echelleResolution: 0.5 },
  BALANCED: { bitrateVideoBps: 1_000_000, bitrateAudioBps: 32_000, ips: 24, echelleResolution: 0.75 },
  PERFORMANCE: { bitrateVideoBps: 2_500_000, bitrateAudioBps: 64_000, ips: 30, echelleResolution: 1 },
  MOBILE: { bitrateVideoBps: 500_000, bitrateAudioBps: 24_000, ips: 15, echelleResolution: 0.5 },
};

export function parametresProfil(profil: ProfilQualite): ParametresProfil {
  return { ...PROFILS[profil] };
}

export interface MetriquesFlux {
  /** RTT mesuré (ms) — getStats ou ping/pong signalisation. */
  rttMs: number;
  /** Perte de paquets (%) mesurée. */
  pertePct: number;
}

export type NiveauAdaptation = "monte" | "stable" | "reduit" | "survival";

export interface DecisionAdaptation {
  niveau: NiveauAdaptation;
  /** Paramètres à appliquer au sender (absents si stable). */
  parametres?: Partial<ParametresProfil>;
  raison: string;
}

/**
 * Décision d'adaptation à partir des métriques réelles — aucun réglage
 * caché : chaque seuil est documenté et testé.
 */
export function deciderAdaptation(
  metriques: MetriquesFlux,
  profil: ProfilQualite = "BALANCED",
): DecisionAdaptation {
  const p = PROFILS[profil];
  // Survie : réseau très dégradé — plancher absolument minimal.
  if (metriques.rttMs > 800 || metriques.pertePct > 15) {
    return {
      niveau: "survival",
      parametres: { bitrateVideoBps: 120_000, ips: 8, echelleResolution: 0.25 },
      raison: `réseau dégradé (RTT ${metriques.rttMs} ms, perte ${metriques.pertePct} %) — plancher de survie, mission « gérer les connexions instables »`,
    };
  }
  // Réduction : dégradation modérée → un cran sous le profil.
  if (metriques.rttMs > 300 || metriques.pertePct > 5) {
    return {
      niveau: "reduit",
      parametres: { bitrateVideoBps: Math.round(p.bitrateVideoBps * 0.5), ips: Math.max(10, Math.round(p.ips * 0.6)) },
      raison: `dégradation modérée (RTT ${metriques.rttMs} ms, perte ${metriques.pertePct} %) — 50 % du débit du profil ${profil}`,
    };
  }
  // Remontée progressive : réseau sain et profil inférieur au max possible.
  if (metriques.rttMs < 80 && metriques.pertePct < 1 && profil !== "PERFORMANCE") {
    return {
      niveau: "monte",
      raison: `réseau sain (RTT ${metriques.rttMs} ms) — montée vers BALANCED recommandée`,
    };
  }
  return { niveau: "stable", raison: `qualité conforme au profil ${profil} (RTT ${metriques.rttMs} ms, perte ${metriques.pertePct} %)` };
}

/**
 * Surveillance de latence : échantillonne des métriques via une sonde
 * injectée (getStats navigateur en prod, mesures factices en tests) et
 * émet les décisions d'adaptation à intervalle borné. L'injectabilité
 * remplace toute simulation : en prod ce sont les VRAIES métriques.
 */
export class SurveillantQualite {
  private dernierNiveau: NiveauAdaptation | null = null;

  constructor(
    private sonde: () => Promise<MetriquesFlux>,
    private profil: ProfilQualite = "BALANCED",
    private intervalleMs = 5_000,
  ) {}

  /** Un cycle de surveillance : mesurer → décider → appliquer (callback injectée). */
  async cycle(appliquer?: (d: DecisionAdaptation) => Promise<void>): Promise<DecisionAdaptation> {
    const metriques = await this.sonde();
    const decision = deciderAdaptation(metriques, this.profil);
    if (decision.niveau !== this.dernierNiveau && decision.parametres) {
      await appliquer?.(decision);
      this.dernierNiveau = decision.niveau;
    }
    return decision;
  }

  /** Boucle bornée (auto-stop après maxCycles — jamais de boucle infinie). */
  async demarrer(appliquer?: (d: DecisionAdaptation) => Promise<void>, maxCycles = 60): Promise<void> {
    for (let i = 0; i < maxCycles; i++) {
      await this.cycle(appliquer);
      await new Promise((r) => setTimeout(r, this.intervalleMs));
    }
  }
}
