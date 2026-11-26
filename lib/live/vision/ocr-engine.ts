/**
 * OCR ENGINE — honnêteté ABSOLUE (mission GEN3IA LIVE Phase 3-B) : aucun
 * moteur OCR local n'existe dans ce dépôt et les services IA externes sont
 * INTERDITS (règle plateforme, commit 95c1dc3). Ce module déclare la
 * capacité indisponible avec sa raison, et fournit l'interface exacte pour
 * brancher un moteur local (tesseract-wasm local, modèle ONNX embarqué)
 * le jour où une dépendance locale est ajoutée au dépôt — jamais de fausse
 * lecture de texte : retourner du texte inventé est interdit.
 */

export interface ResultatOcr {
  disponible: boolean;
  raisonIndisponibilite?: string;
  /** Textes lus (uniquement si un moteur local est branché). */
  textes?: Array<{ contenu: string; zone: { x: number; y: number; largeur: number; hauteur: number }; confiance: number }>;
  /** Boutons/menus reconnus (Phase 3-B) — uniquement via OCR local. */
  elementsInterface?: Array<{ type: "bouton" | "menu" | "champ" | "message-erreur"; texte: string }>;
}

const RaisonInconnue = "aucun moteur OCR local dans le dépôt (aucun modèle .onnx, aucun tesseract local) — les services IA externes sont interdits par la règle plateforme (95c1dc3) : le texte des écrans N'EST PAS lu tant qu'aucun moteur local n'est ajouté";

/** Vérifie la présence d'un moteur OCR local (aucune promesse non tenue). */
export function verifierMoteurOcrLocal(): { disponible: boolean; raison?: string } {
  return { disponible: false, raison: RaisonInconnue };
}

/** Lecture OCR : indisponible tant qu'aucun moteur local n'est branché. */
export async function lireTexte(_jpeg: Buffer): Promise<ResultatOcr> {
  void _jpeg;
  return { disponible: false, raisonIndisponibilite: RaisonInconnue };
}

/** Enregistre un moteur local (prototypage futur — requis avant tout usage). */
export function brancherMoteurOcrLocal(_moteur: { lireTexte: (jpeg: Buffer) => Promise<ResultatOcr> }): never {
  throw new Error("aucun moteur OCR local n'est fourni par ce dépôt — ajouter une dépendance locale (ex. tesseract-wasm empaqueté) avant de brancher ; jamais de faux texte");
}
