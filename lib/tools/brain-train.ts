import { z } from "zod";
import type { ToolDefinition } from "@/lib/tools/types";
import type { PaireLangage } from "@/lib/neural/generation/corpus";
import {
  chargerAbréviations,
  tailleDictionnaireAbréviations,
  ingérerAbréviationsDansCortex,
} from "@/lib/neural/abbreviations";

/**
 * Outil brain.train — ENTRAÎNEMENT DEPUIS LE CHAT (entrée UNIQUE).
 *
 * Demande utilisateur : « les utilisateurs doivent entraîner gen3 depuis le
 * chat IA et pas ailleurs ». Cet outil est le point d'entrée réel : il
 * parse des connaissances en langage naturel et les apprend VRAIMENT dans
 * le cortex langagier (apprendre() — plasticité par paires motif/réponse,
 * idempotente, poids d'usage persistant).
 *
 * Formats acceptés (détection naturelle, aucun format technique exigé) :
 *  - « apprends que X signifie Y » / « retiens que X = Y » / « X = Y »
 *  - plusieurs lignes : une connaissance par ligne
 *  - domain « abbreviations » : « apprends que XYZ veut dire Zone Xénophile »
 *    → la paire alimente AUSSI le dictionnaire d'expansion à l'encodage
 *      (rechargé dynamiquement).
 *
 * Le rapport est 100 % honnête : paires réellement ajoutées, doublons
 * ignorés (idempotence cortex), taille courante du dictionnaire.
 */

const PaireSchema = z.object({
  motif: z.string().min(1).max(280),
  reponse: z.string().min(1).max(1200),
});

const BrainTrainInput = z.object({
  /** Domaine de l'entraînement (défaut : libre — toute connaissance). */
  domain: z.enum(["libre", "abbreviations"]).optional(),
  /** Texte naturel contenant les connaissances (une par ligne idéalement). */
  texte: z.string().max(8000).optional(),
  /** Paires explicites (quand le planner les a déjà structurées). */
  paires: z.array(PaireSchema).max(50).optional(),
  /** Recharger le dataset abréviations complet (demande explicite). */
  rechargerDataset: z.boolean().optional(),
});

interface BrainTrainOutput {
  /** Paires réellement ajoutées au cortex. */
  ajoutees: number;
  /** Paires ignorées (motif déjà connu — idempotence). */
  doublons: number;
  /** Domaine effectif. */
  domain: string;
  /** Taille du dictionnaire d'abréviations actif à l'encodage. */
  dictionnaireAbréviations?: number;
  /** Détails honnêtes pour la réponse au chat. */
  details: string;
}

/** Parse « X = Y », « X signifie Y », « X veut dire Y », « apprends que X est Y ». */
function parserConnaissances(texte: string): PaireLangage[] {
  const paires: PaireLangage[] = [];
  for (const ligneBrute of texte.split(/\n|(?<=[.!?;])\s+(?=[A-ZÀ-ÖØ-Þ0-9«"])/)) {
    const ligne = ligneBrute.trim().replace(/^[-•*\d.)\s]+/, "");
    if (ligne.length < 3) continue;
    const nettoyée = ligne
      .replace(/^apprends? (?:que |ça que )?/i, "")
      .replace(/^retiens? (?:que |ça )?/i, "")
      .replace(/^souviens?-toi (?:que )?/i, "")
      .replace(/^note (?:que )?/i, "")
      .trim();
    const m = nettoyée.match(/^(.{1,120}?)\s*(?:=|:|signifie|veut dire|veut-dire|c'est|est)\s+(.{1,600})$/i);
    if (m && m[1].trim() && m[2].trim()) {
      paires.push({ motif: `que signifie ${m[1].trim().toLowerCase()} ?`, reponse: m[2].trim(), theme: "enseigné-chat" });
      continue;
    }
    // Question brute apprise telle quelle (motif conversationnel).
    if (nettoyée.includes("?")) {
      paires.push({ motif: nettoyée.toLowerCase(), reponse: nettoyée, theme: "enseigné-chat" });
    }
  }
  return paires;
}

export const brainTrainTool: ToolDefinition<
  z.infer<typeof BrainTrainInput>,
  BrainTrainOutput
> = {
  id: "brain.train",
  name: "brain.train",
  description:
    "Entraîne le cerveau Gen3 depuis la conversation : apprends-lui des connaissances " +
    "« apprends que X signifie Y », des abréviations (« retiens que IAAP = … »), ou recharge " +
    "le dataset d'abréviations complet. Apprentissage RÉEL dans le cortex langagier.",
  category: "system",
  risk: "low",
  inputSchema: BrainTrainInput,
  async execute(input, context): Promise<BrainTrainOutput> {
    void context;
    await chargerAbréviations();
    const { getNeuralRuntime } = await import("@/lib/neural/runtime");
    const rt = getNeuralRuntime();

    let ajoutees = 0;
    let doublons = 0;
    const domain = input.domain ?? "libre";
    const détailParts: string[] = [];

    // 1. Paires explicites du planner → apprentissage direct.
    if (input.paires && input.paires.length > 0) {
      const stats = rt.cortex.apprendre(
        input.paires.map((p) => ({ motif: p.motif, reponse: p.reponse, theme: "enseigné-chat" })),
        { personnalisees: true },
      );
      ajoutees += stats.pairesAjoutees;
      doublons += stats.pairesDoublons;
      détailParts.push(`${stats.pairesAjoutees} paire(s) explicite(s) apprise(s)`);
    }

    // 2. Texte naturel → parse « X = Y » / « X signifie Y ».
    if (input.texte && input.texte.trim().length >= 3) {
      const paires = parserConnaissances(input.texte);
      if (paires.length > 0) {
        const stats = rt.cortex.apprendre(paires, { personnalisees: true });
        ajoutees += stats.pairesAjoutees;
        doublons += stats.pairesDoublons;
        détailParts.push(`${stats.pairesAjoutees} connaissance(s) extraite(s) du texte`);
      }
    }

    // 3. Domaine abréviations : le dataset complet est (re)chargé + le
    //    dictionnaire d'expansion à l'encodage est actif immédiatement.
    if (domain === "abbreviations" || input.rechargerDataset) {
      const ingestion = await ingérerAbréviationsDansCortex((paires, opts) =>
        rt.cortex.apprendre(paires, opts),
      );
      if (ingestion && !ingestion.déjaFait) {
        ajoutees += ingestion.ajoutées;
        doublons += ingestion.doublons;
        détailParts.push(`dataset abréviations : ${ingestion.ajoutées} ajoutée(s)`);
      } else if (ingestion?.déjaFait) {
        détailParts.push("dataset abréviations déjà appris (idempotent)");
      }
    }

    const total = ajoutees + doublons;
    return {
      ajoutees,
      doublons,
      domain,
      dictionnaireAbréviations: tailleDictionnaireAbréviations(),
      details:
        total === 0
          ? "Aucune connaissance exploitable détectée. Formule : « apprends que X signifie Y » (une par ligne)."
          : `Entraînement terminé — ${ajoutees} nouvelle(s) connaissance(s) apprise(s)` +
            (doublons > 0 ? `, ${doublons} déjà connue(s) ignorée(s)` : "") +
            (détailParts.length > 0 ? ` (${détailParts.join(" ; ")})` : "") +
            ".",
    };
  },
};
