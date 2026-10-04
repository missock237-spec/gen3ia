/**
 * DÉTECTION DE DEMANDE DE VIDÉO — routage déterministe (zéro variance LLM)
 * vers la production vidéo autopilotée (file `videoProductionJobs`).
 *
 * Miroir de `lib/ai/image-generation.ts` (looksLikeImageRequest) : verbe de
 * création + nom de vidéo. Garde-fous :
 *  - les demandes de PAGES/SITES web restent routées vers l'artefact
 *    application (détection amont) — jamais vers une production vidéo ;
 *  - les questions méta (« c'est quoi un bon montage vidéo ? »,
 *    « comment créer une vidéo ? ») ne déclenchent PAS de production ;
 *  - FR + EN.
 */

const VIDEO_NOUN_RE =
  /\b(vid[ée]os?|videos?|clip|clips|reels?|shorts?|short video|montage|montages|film|trailer|teaser|bande[- ]annonce|bande annonce|pub vid[ée]o|publicit[ée] vid[ée]o|vid[ée]o publicitaire|tutoriel vid[ée]o|animation)\b/i;

const VIDEO_CREATION_VERB_RE =
  /\b(cr[ée][eé]?[sr]?|cr[ée]er?|g[ée]n[èe]re[rz]?|g[ée]n[èe]rer?|fais[ez]?|fait|fabriqu\w*|produis\w*|produire|monte[rz]?|monter|montage|r[ée]alis\w*|r[ée]aliser|confectionn\w*|veux|voudrais|aimerais|lance[rz]?|make|create|generate|produce|edit|render|want)\b/i;

/** Amorce interrogative : une pure question méta ne produit pas de vidéo. */
const QUESTION_PREFIX_RE =
  /^(c['']est quoi|qu['']est[- ]ce|pourquoi|comment|qui (est|a)|o[ùu]|quand|quel(?:le)?s?(?:\s+\w+){0,3}\s|est[- ]ce que|what|why|how|who|where|which)\b/i;

/** Demandes de pages/web/app : routage artefact application, PAS vidéo. */
const WEB_APP_CONTEXT_RE =
  /\b(page (web|d['']accueil|de vente)|site (web|internet|vitrine)|landing|application (web|mobile)|page de|web app|html|site avec|page avec)\b/i;

/** Question méta posée SUR le sujet vidéo (sans intention de production). */
const META_QUESTION_RE =
  /\b(c['']est quoi|qu['']est[- ]ce que|signifie|veut dire|diff[ée]rence|conseils?|astuces?|meilleur (logiciel|outil)|comment (fonctionne|marche))\b/i;

/**
 * La demande exprime-t-elle une production vidéo COMPLÈTE à lancer ?
 * (usage moteur : court-circuit déterministe avant la décision d'intention)
 */
export function looksLikeVideoRequest(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 6) return false;
  const lower = trimmed.toLowerCase();
  if (WEB_APP_CONTEXT_RE.test(lower)) return false;
  if (META_QUESTION_RE.test(lower) && !/\b(g[ée]n[èe]re|cr[ée]e|fais|monte|lance)\s+(moi\s+)?(une?|la|le|des)\b/i.test(lower)) {
    return false;
  }
  if (QUESTION_PREFIX_RE.test(trimmed)) return false;
  return VIDEO_NOUN_RE.test(lower) && VIDEO_CREATION_VERB_RE.test(lower);
}

/**
 * Titre court de la production, dérivé de la demande (nettoyage des
 * formules d'adresse, ponctuation tronquée) — affiché dans l'atelier vidéo.
 */
export function extractVideoTitle(text: string): string {
  const cleaned = text
    .replace(/^(fais[ez]?[- ]?moi|g[ée]n[èe]re[rz]?[- ]?moi|cr[ée][eé]?[sr]?[- ]?moi|peux[- ]tu|pourrais[- ]tu|pourriez[- ]tu|merci de|stp|s['']il (te|vous) pla[iî]t)\s+/i, "")
    .replace(/^(cr[ée][eé]?[sr]?|g[ée]n[èe]re[rz]?|fais[ez]?|monte[rz]?|lance[rz]?|produis|je veux|je voudrais|j['']aimerais)\s+/i, "")
    .replace(/^(moi |nous )\s*/i, "")
    .replace(/^(une? |le |la |des |de la |du )\s*/i, "")
    .replace(/^(vid[ée]o|video|clip|reel|short|montage|film)\s+/i, "")
    .replace(/^(sur |about |de |du |pour )+/i, "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/\s+/g, " ")
    .trim();
  const base = cleaned || text.trim();
  return base.slice(0, 80) || "Production vidéo";
}
