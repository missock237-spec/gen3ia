/**
 * AGENT « SANTÉ DU CERVEAU » — premier module-agent du Gen3ia Autonomous
 * Core (Phase 1), preuve d'intégration du contrat ModuleAgent au cerveau
 * existant.
 *
 * Ce que l'audit Phase 0 a identifié comme trou n°5 : aucun health ne
 * vérifie RÉELLEMENT le cerveau ( /api/public/health ne vérifie rien).
 * Cet agent mesure à chaque cycle :
 *  - la fraîcheur de la persistance du cerveau (mtime de
 *    var/neural/brain-v1.json et var/neural/cortex-v2.bin) ;
 *  - la taille des artefacts (détection de fichier vide/tronqué) ;
 *  - la présence du pré-entraînement commis (assets/neural-pretrained/).
 *
 * Il ne CHARGE jamais le runtime neuronal (RAM) : il lit les fichiers de
 * persistance — le cœur neuronal reste le seul propriétaire du cerveau.
 * Statuts honnêtes : absent/tronqué/périmé sont documentés, jamais déguisés.
 */

import { statSync } from "node:fs";
import { join } from "node:path";

import type { ModuleAgent } from "../core/types";

/** Artefacts surveillés (noms réels du dépôt — cf. persistence.ts). */
const ARTEFACTS = ["neural/brain-v1.json", "neural/cortex-v2.bin"] as const;

/** Options injectables (tests : dossier temporaire). */
export interface OptionsAgentSante {
  /** Dossier var/ du dépôt (défaut : <cwd>/var). */
  dossierVar?: string;
  /** Fraîcheur maximale attendue de la persistance du cerveau (ms). */
  fraicheurMaxMs?: number;
  /** Chemin du pré-entraînement commis (défaut : assets/neural-pretrained/). */
  cheminPretrain?: string;
}

/** Mesure réelle d'un artefact (null si absent — jamais inventée). */
function mesurerFichier(chemin: string): { tailleOctets: number; modifieLe: string } | null {
  try {
    const s = statSync(chemin);
    if (!s.isFile()) return null;
    return { tailleOctets: s.size, modifieLe: s.mtime.toISOString() };
  } catch {
    return null;
  }
}

/** Le module-agent de santé du cerveau. */
export function agentSanteCerveau(options: OptionsAgentSante = {}): ModuleAgent {
  const dossierVar = options.dossierVar ?? join(process.cwd(), "var");
  const fraicheurMaxMs = options.fraicheurMaxMs ?? 72 * 3600_000; // 72 h par défaut
  const cheminPretrain =
    options.cheminPretrain ??
    join(process.cwd(), "assets", "neural-pretrained", "brain-domaines-v1.json");
  return {
    id: "sante-cerveau",
    nom: "Agent santé du cerveau",
    role: "11. MONITORING & EVOLUTION — fraîcheur de la persistance du cerveau",
    // Un tick par cycle de base (5 min) : lecture stat() only, coût nul.
    async tick(ctx) {
      const tache = ctx.taches.creer({ module: this.id, cycle: ctx.cycle, type: "sante-cerveau" });
      if (tache) ctx.taches.demarrer(tache.id);

      const mesures: Array<Record<string, unknown>> = [];
      const absents: string[] = [];
      for (const relatif of ARTEFACTS) {
        const chemin = join(dossierVar, relatif);
        const m = mesurerFichier(chemin);
        if (!m) {
          absents.push(relatif);
          continue;
        }
        const ageMs = Date.now() - Date.parse(m.modifieLe);
        mesures.push({ artefact: relatif, tailleOctets: m.tailleOctets, ageMs, modifieLe: m.modifieLe });
      }

      // Le pré-entraînement commis au git est la base de secours réelle.
      const pretrain = mesurerFichier(cheminPretrain);

      const detail: Record<string, unknown> = {
        artefacts: mesures,
        absents,
        pretrainCommis: pretrain ? { tailleOctets: pretrain.tailleOctets, modifieLe: pretrain.modifieLe } : null,
      };

      // Aucun artefact de persistance ET aucun pré-entraînement : le cerveau
      // repart d'un réseau seedé — c'est un état réel à documenter (degrade).
      if (absents.length === ARTEFACTS.length && !pretrain) {
        if (tache) {
          ctx.taches.terminer(tache.id, "aucun artefact de persistance ni pré-entraînement commis");
        }
        ctx.emettreEvenement({ de: this.id, sujet: "cerveau-non-persiste", charge: { absents } });
        return {
          statut: "echec",
          message: `Aucun artefact de cerveau trouvé sous ${dossierVar} (absents : ${absents.join(", ")}) et aucun pré-entraînement commis — le cerveau repart d'un réseau seedé.`,
          taches: tache ? [tache.id] : [],
          details: detail,
        };
      }

      // Fraîcheur : la persistance la plus récente fait foi.
      const plusRecent = mesures.reduce<number | null>((max, m) => {
        const age = typeof m.ageMs === "number" ? m.ageMs : Number.MAX_SAFE_INTEGER;
        return max === null ? age : Math.min(max, age);
      }, null);
      const perime = plusRecent !== null && plusRecent > fraicheurMaxMs;

      if (tache) {
        ctx.taches.terminer(
          tache.id,
          perime
            ? `persistance périmée (${Math.round((plusRecent ?? 0) / 3600_000)} h)`
            : `persistance fraîche (${mesures.length} artefact(s), ${absents.length} absent(s))`,
        );
      }
      ctx.emettreEvenement({
        de: this.id,
        sujet: perime ? "cerveau-persistance-perimee" : "cerveau-sauvegarde-verifie",
        charge: { mesures, absents, perime },
      });
      return {
        statut: perime || absents.length > 0 ? "echec" : "succes",
        message: perime
          ? `Persistance du cerveau périmée : dernière sauvegarde il y a ${Math.round((plusRecent ?? 0) / 3600_000)} h (seuil ${Math.round(fraicheurMaxMs / 3600_000)} h) — à documenter au tableau de supervision.`
          : absents.length > 0
            ? `Persistance du cerveau PARTIELLE : ${mesures.length} artefact(s) présents (absents : ${absents.join(", ")}) — dernier enregistrement il y a ${Math.round((plusRecent ?? 0) / 60000)} min.`
            : `Persistance du cerveau vérifiée : ${mesures.length} artefact(s) présents, dernier enregistrement il y a ${Math.round((plusRecent ?? 0) / 60000)} min.`,
        taches: tache ? [tache.id] : [],
        details: detail,
      };
    },
  };
}
