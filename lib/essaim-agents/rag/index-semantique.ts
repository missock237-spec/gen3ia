/**
 * Index sémantique local — le cœur du RAG ZÉRO-CONNAISSANCE.
 *
 * Pas d'embeddings distants, pas de modèle à télécharger, pas de
 * serveur : chaque token est projeté dans un vecteur creux de 256
 * dimensions par double hachage FNV-1a (même famille d'empreintes que
 * le champ d'ondes W-DNN — la sémantique vit donc dans le MÊME espace
 * fréquentiel que l'inférence). La similarité cosinus relie une requête
 * aux fragments locaux. L'index ne connaît QUE le contenu déchiffré
 * localement : il ne sort jamais de la machine, seuls des extraits
 * répondent à une onde de requête.
 */

/** Dimensions du vecteur creux (compromis précision / taille d'onde). */
export const DIMENSIONS_VECTEUR = 256;

/** Taille maximale d'un fragment indexé (caractères). */
export const TAILLE_FRAGMENT = 420;

/** Chevauchement entre fragments consécutifs (caractères). */
export const CHEVAUCHEMENT_FRAGMENT = 60;

/** Mots vides français — sans valeur discriminante. */
const MOTS_VIDES = new Set([
  "au", "aux", "avec", "ce", "ces", "cet", "cette", "chaque", "comme", "dans",
  "de", "des", "du", "elle", "en", "et", "eux", "il", "ils", "je", "la", "le",
  "les", "leur", "lui", "ma", "mais", "me", "meme", "mes", "moi", "mon", "ne",
  "nos", "notre", "nous", "on", "ou", "par", "pas", "pour", "qu", "que", "qui",
  "sa", "se", "ses", "son", "sur", "ta", "te", "tes", "toi", "ton", "tu",
  "un", "une", "vos", "votre", "vous", "et", "est", "sont", "etre", "avoir",
  "a", "d", "l", "s", "n", "m", "j", "c", "y",
]);

/** FNV-1a 32 bits (déterministe, sans dépendance). */
function fnv1a(texte: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < texte.length; i++) {
    h ^= texte.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Normalise un mot : minuscules, sans diacritiques. */
function normaliser(mot: string): string {
  return mot
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

/** Tokenise un texte : mots normalisés, vides exclus, bornés. */
export function tokeniser(texte: string, maxJetons = 512): string[] {
  const mots = normaliser(texte)
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((m) => m.length >= 2 && m.length <= 24 && !MOTS_VIDES.has(m));
  return mots.slice(0, maxJetons);
}

/** Vecteur creux : { [dimension]: poids }, L2-normalisé. */
export type VecteurCreux = Record<number, number>;

/** Projette un texte dans l'espace fréquentiel (double hachage). */
export function vectoriser(texte: string): VecteurCreux {
  const jetons = tokeniser(texte);
  const vecteur: VecteurCreux = {};
  for (const jeton of jetons) {
    const h = fnv1a(jeton);
    const d1 = h % DIMENSIONS_VECTEUR;
    const d2 = (h >>> 8) % DIMENSIONS_VECTEUR;
    // Poids 1 + accentuation des mots rares (heuristique légère).
    vecteur[d1] = (vecteur[d1] ?? 0) + 1;
    if (d2 !== d1) vecteur[d2] = (vecteur[d2] ?? 0) + 0.5;
  }
  // Normalisation L2.
  let norme = 0;
  for (const w of Object.values(vecteur)) norme += w * w;
  norme = Math.sqrt(norme) || 1;
  for (const d of Object.keys(vecteur)) {
    vecteur[Number(d)] = vecteur[Number(d)] / norme;
  }
  return vecteur;
}

/** Similarité cosinus entre deux vecteurs creux. */
export function similariteCosinus(a: VecteurCreux, b: VecteurCreux): number {
  let produit = 0;
  for (const [d, w] of Object.entries(a)) {
    const wb = b[Number(d)];
    if (wb) produit += w * wb;
  }
  // Les deux sont L2-normalisés : le produit scalaire EST le cosinus.
  return Math.max(0, Math.min(1, produit));
}

/** Découpe un texte en fragments bornés avec chevauchement. */
export function decouperEnFragments(texte: string, max = TAILLE_FRAGMENT): string[] {
  const propre = texte.replace(/\s+/g, " ").trim();
  if (propre.length <= max) return propre ? [propre] : [];
  const fragments: string[] = [];
  let debut = 0;
  while (debut < propre.length && fragments.length < 256) {
    let fin = Math.min(debut + max, propre.length);
    if (fin < propre.length) {
      // Coupe au dernier séparateur de phrase si possible.
      const fenetre = propre.slice(debut, fin);
      const coupe = Math.max(fenetre.lastIndexOf(". "), fenetre.lastIndexOf(", "));
      if (coupe > max * 0.5) fin = debut + coupe + 1;
    }
    fragments.push(propre.slice(debut, fin).trim());
    debut = fin - CHEVAUCHEMENT_FRAGMENT;
    if (debut < 0) debut = 0;
  }
  return fragments;
}

/** Un fragment indexé localement. */
export interface FragmentIndex {
  id: string;
  texte: string;
  etiquette?: string;
  vecteur: VecteurCreux;
  empreinte: string;
  ts: number;
}

export interface ReponseIndex {
  fragment: FragmentIndex;
  score: number;
}

/**
 * L'index sémantique du nœud — purement local, en mémoire (le contenu
 * source reste chiffré dans le coffre ; l'index en mémoire disparaît à
 * la fermeture, ce qui renforce la confidentialité).
 */
export class IndexSemantiqueLocal {
  private fragments = new Map<string, FragmentIndex>();

  get taille(): number {
    return this.fragments.size;
  }

  /** Indexe un texte (découpé en fragments automatiquement). */
  indexer(texte: string, etiquette?: string, prefixeId = "f"): number {
    const morceaux = decouperEnFragments(texte);
    let ajout = 0;
    morceaux.forEach((morceau, i) => {
      const id = `${prefixeId}-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 5)}`;
      this.fragments.set(id, {
        id,
        texte: morceau,
        etiquette,
        vecteur: vectoriser(morceau),
        empreinte: fnv1a(morceau).toString(16).padStart(8, "0"),
        ts: Date.now(),
      });
      ajout++;
    });
    return ajout;
  }

  /** Retire un document entier (par préfixe d'identifiant). */
  retirer(prefixe: string): number {
    let retirés = 0;
    for (const [id] of this.fragments) {
      if (id.startsWith(prefixe)) {
        this.fragments.delete(id);
        retirés++;
      }
    }
    return retirés;
  }

  vide(): void {
    this.fragments.clear();
  }

  /** Recherche locale : les N meilleurs fragments au-dessus du seuil. */
  requeter(texte: string, seuil = 0.12, max = 4): ReponseIndex[] {
    const vecteur = vectoriser(texte);
    const reponses: ReponseIndex[] = [];
    for (const fragment of this.fragments.values()) {
      const score = similariteCosinus(vecteur, fragment.vecteur);
      if (score >= seuil) reponses.push({ fragment, score });
    }
    return reponses.sort((a, b) => b.score - a.score).slice(0, max);
  }

  /** Fragments (pour l'inspection locale uniquement). */
  tous(): FragmentIndex[] {
    return [...this.fragments.values()];
  }

  /** Signature compacte d'une requête — ce qui SORT de la machine. */
  signatureRequete(texte: string, maxDims = 24): { dims: number[]; poids: number[] } {
    const vecteur = vectoriser(texte);
    const paires = Object.entries(vecteur)
      .map(([d, w]) => ({ d: Number(d), w }))
      .sort((a, b) => b.w - a.w)
      .slice(0, maxDims);
    return {
      dims: paires.map((p) => p.d),
      poids: paires.map((p) => Math.round(p.w * 1000) / 1000),
    };
  }
}
