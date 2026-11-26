/**
 * OCR ENGINE — adaptateur remplaçable (règle 11 mission : « Toute
 * dépendance externe doit être encapsulée dans un adaptateur remplaçable »).
 * HONNÊTETÉ ABSOLUE (mission LOT 3 : « Les capacités non implémentées
 * doivent être signalées explicitement ») :
 *  · Aucun moteur OCR n'est fourni par ce dépôt (aucun modèle .onnx
 *    embarqué) et les services IA externes sont interdits (règle
 *    plateforme 95c1dc3) : tant qu'aucun moteur local n'est branché via
 *    definirMoteurOcrLocal(), lireTexte() retourne « indisponible avec
 *    raison » — JAMAIS de texte inventé.
 *  · Brancher un moteur réel (ex. tesseract-wasm empaqueté avec ses
 *    données de langue dans le dépôt) se fait par cette interface SANS
 *    toucher au reste de la chaîne vision → cerveau.
 */

export interface ZoneOcr {
  x: number;
  y: number;
  largeur: number;
  hauteur: number;
}

export interface TexteOcr {
  contenu: string;
  zone: ZoneOcr;
  /** Confiance du moteur OCR [0..1] — transmise telle quelle au cerveau. */
  confiance: number;
}

export interface ElementInterfaceOcr {
  type: "bouton" | "menu" | "champ" | "message-erreur";
  texte: string;
  zone: ZoneOcr;
  confiance: number;
}

export interface ResultatOcr {
  /** true seulement si un moteur local est branché ET a réellement lu. */
  disponible: boolean;
  moteur?: string;
  raisonIndisponibilite?: string;
  textes?: TexteOcr[];
  elementsInterface?: ElementInterfaceOcr[];
  /** Confiance globale de la lecture [0..1] (le moteur la déclare). */
  confiance?: number;
}

/** Contrat exact que tout moteur OCR local doit implémenter (remplaçable). */
export interface MoteurOcrLocal {
  /** Nom identifiable (journalisation et honnêteté des rapports). */
  readonly nom: string;
  lireTexte(jpeg: Buffer): Promise<{ textes: TexteOcr[]; elementsInterface?: ElementInterfaceOcr[]; confiance: number }>;
}

const RAISON_ABSENCE =
  "aucun moteur OCR local branché — le dépôt n'embede aucun modèle OCR et les services IA externes sont interdits (règle plateforme 95c1dc3) : le texte des écrans n'est PAS lu tant qu'aucun moteur local n'est défini via definirMoteurOcrLocal()";

const globalOcr = globalThis as typeof globalThis & { __gen3iaLiveMoteurOcr?: MoteurOcrLocal };

/** Branche un moteur local (remplaçable — règle 11). Rejet d'un moteur invalide. */
export function definirMoteurOcrLocal(moteur: MoteurOcrLocal): void {
  if (!moteur || typeof moteur.nom !== "string" || !moteur.nom || typeof moteur.lireTexte !== "function") {
    throw new Error("moteur OCR invalide : 'nom' (chaîne non vide) et 'lireTexte(jpeg)' sont requis");
  }
  globalOcr.__gen3iaLiveMoteurOcr = moteur;
}

export function reinitialiserMoteurOcr(): void {
  delete globalOcr.__gen3iaLiveMoteurOcr;
}

export function moteurOcrActif(): { nom: string } | null {
  const m = globalOcr.__gen3iaLiveMoteurOcr;
  return m ? { nom: m.nom } : null;
}

/** Lecture OCR : moteur branché → vraie lecture ; sinon indisponible avec raison. */
export async function lireTexte(jpeg: Buffer): Promise<ResultatOcr> {
  const moteur = globalOcr.__gen3iaLiveMoteurOcr;
  if (!moteur) {
    return { disponible: false, raisonIndisponibilite: RAISON_ABSENCE };
  }
  try {
    const lecture = await moteur.lireTexte(jpeg);
    return {
      disponible: true,
      moteur: moteur.nom,
      textes: lecture.textes,
      elementsInterface: lecture.elementsInterface,
      confiance: Math.max(0, Math.min(1, lecture.confiance)),
    };
  } catch (erreur) {
    return {
      disponible: false,
      moteur: moteur.nom,
      raisonIndisponibilite: `le moteur OCR branché « ${moteur.nom} » a échoué : ${erreur instanceof Error ? erreur.message : String(erreur)}`,
    };
  }
}
