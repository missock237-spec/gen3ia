import type { TypeArtefact } from "./valideurs/contrat";

/**
 * AGENTS-OS — RÉPARATEUR DÉTERMINISTE (Module 3 : drop-and-fix).
 *
 * Passes de correction automatique des erreurs structurelles COURANTES —
 * chaque passe est pure, localisée, et décrite dans le journal des
 * réparations (ligne, avant, après, passe). Aucune passe n'invente de
 * contenu métier : on corrige la STRUCTURE (indentation, guillemets,
 * séparateurs), jamais la SÉMANTIQUE.
 *
 * Le service-audit enchaîne : passer → revalider → repasser (borné à
 * MAX_PASSES, une passe sans changement arrête la boucle).
 */

export interface Reparation {
  /** Ligne 1-indexée concernée (0 = global). */
  readonly ligne: number;
  readonly passe: string;
  readonly avant: string;
  readonly apres: string;
}

export interface ResultatReparation {
  readonly contenu: string;
  readonly reparations: readonly Reparation[];
}

const MAX_PASSES = 5;

export function maxPasses(): number {
  return MAX_PASSES;
}

/** Applique les passes adaptées au type, une passe = un balayage complet. */
export function reparer(contenu: string, type: TypeArtefact): ResultatReparation {
  let courant = contenu;
  const reparations: Reparation[] = [];

  for (let passe = 0; passe < MAX_PASSES; passe++) {
    const avantPasse = courant;
    courant = appliquerPasse(courant, type, reparations);
    if (courant === avantPasse) break; // stabilisé
  }

  return { contenu: courant, reparations };
}

/** Un balayage : normalisations globales + passes par type. */
function appliquerPasse(contenu: string, type: TypeArtefact, journal: Reparation[]): string {
  let texte = contenu;

  // Passe G1 : BOM + CRLF → LF.
  const g1 = texte.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (g1 !== texte) {
    journal.push({ ligne: 0, passe: "normalisation", avant: "BOM/CRLF", apres: "UTF-8/LF" });
    texte = g1;
  }

  // Passe G2 : espaces traînants (pas les vides fins YAML significatifs —
  // uniquement en FIN de ligne, jamais significatif dans les 5 types).
  const lignes = texte.split("\n").map((l) => l.replace(/[ \t]+$/, ""));
  const g2 = lignes.join("\n");
  if (g2 !== texte) {
    journal.push({ ligne: 0, passe: "espaces-traînants", avant: "espaces en fin de ligne", apres: "supprimés" });
    texte = g2;
  }

  if (type === "json") return passeJson(texte, journal);
  if (type === "yaml" || type === "docker-compose") return passeYaml(texte, journal, type);
  if (type === "nginx") return passeNginx(texte, journal);
  return texte; // javascript/typescript : réparation structurelle non tentée
}

/* ------------------------------- JSON ------------------------------------- */

function passeJson(texte: string, journal: Reparation[]): string {
  const lignes = texte.split("\n");
  const sortie = lignes.map((ligne, index) => {
    let corrigee = ligne;
    const numero = index + 1;

    // J1 : commentaires // et /* */ (JSON strict n'en a pas).
    const sansCommentaires = corrigee.replace(/(^|\s)\/\/.*$/g, "$1").replace(/\/\*.*?\*\//g, "");
    if (sansCommentaires !== corrigee) {
      journal.push({ ligne: numero, passe: "json-commentaires", avant: corrigee.trim().slice(0, 80), apres: sansCommentaires.trim().slice(0, 80) });
      corrigee = sansCommentaires;
    }

    // J2 : guillemets simples → doubles (hors apostrophes de contenu :
    // la passe ne s'applique que si la ligne contient UNE paire 'clé' ou
    // 'valeur' complète — heuristique bornée, revalidation après).
    const guillemets = corrigerGuillemetsJson(corrigee);
    if (guillemets !== corrigee) {
      journal.push({ ligne: numero, passe: "json-guillemets", avant: corrigee.trim().slice(0, 80), apres: guillemets.trim().slice(0, 80) });
      corrigee = guillemets;
    }

    // J3 : clés non quotées { cle: valeur } → { "cle": valeur } — la clé
    // peut suivre { , sur la même ligne OU débuter la ligne (indentée).
    const cleQuotee = corrigee
      .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/g, '$1"$2"$3')
      .replace(/^(\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/, '$1"$2"$3');
    if (cleQuotee !== corrigee) {
      journal.push({ ligne: numero, passe: "json-cle-non-quotee", avant: corrigee.trim().slice(0, 80), apres: cleQuotee.trim().slice(0, 80) });
      corrigee = cleQuotee;
    }

    return corrigee;
  });

  // J4 (GLOBALE) : virgules traînantes avant } ou ] — scan caractère par
  // caractère (chaînes respectées, virgules internes jamais touchées).
  // Couvre à la fois « [2,3,] » ET « "deux",\n } » ET « …}, (top-level) ».
  const sansTraînantes = retirerVirgulesTraînantes(sortie.join("\n"));
  if (sansTraînantes !== sortie.join("\n")) {
    journal.push({ ligne: 0, passe: "json-virgule-traînante", avant: ",} / ,] (hors chaînes)", apres: "} / ] (virgule retirée)" });
    return sansTraînantes;
  }
  return sortie.join("\n");
}

/** Retire les virgules (hors chaînes) immédiatement suivies de } ou ] —
 *  ainsi que les virgules du TOP-LEVEL en fin de document (profondeur 0). */
function retirerVirgulesTraînantes(texte: string): string {
  let resultat = "";
  let dansChaine = false;
  let guillemet = "";
  let profondeur = 0;
  for (let i = 0; i < texte.length; i++) {
    const c = texte[i];
    if (dansChaine) {
      resultat += c;
      if (c === guillemet && texte[i - 1] !== "\\") dansChaine = false;
      continue;
    }
    if (c === '"' || c === "'") {
      dansChaine = true;
      guillemet = c;
      resultat += c;
      continue;
    }
    if (c === "{" || c === "[") profondeur++;
    else if (c === "}" || c === "]") profondeur = Math.max(0, profondeur - 1);
    if (c === ",") {
      // Traînante si : le prochain non-espace est } / ] — OU fin de
      // document en profondeur 0 (virgule après la valeur racine).
      let k = i + 1;
      while (k < texte.length && /\s/.test(texte[k])) k++;
      const fermeture = k < texte.length && (texte[k] === "}" || texte[k] === "]");
      const finTopLevel = k >= texte.length && profondeur === 0;
      if (fermeture || finTopLevel) {
        continue; // virgule traînante : sautée
      }
    }
    resultat += c;
  }
  return resultat;
}

/** Guillemets simples → doubles quand la ligne porte une paire '…'. */
function corrigerGuillemetsJson(ligne: string): string {
  // clé: 'valeur' → clé: "valeur" — apostrophe interne protégée : la passe
  // ne matche que '…' SANS apostrophe interne.
  return ligne.replace(/'([^'\n]*)'/g, (tout, interieur: string) => (interieur.includes('"') ? tout : `"${interieur}"`));
}

/* -------------------------------- YAML ------------------------------------ */

function passeYaml(texte: string, journal: Reparation[], type: "yaml" | "docker-compose"): string {
  const lignes = texte.split("\n");
  const sortie = lignes.map((ligne, index) => {
    let corrigee = ligne;
    const numero = index + 1;

    // Y1 : tabulations → 2 espaces (interdites en YAML, fausse indentation).
    if (/\t/.test(corrigee)) {
      journal.push({ ligne: numero, passe: "yaml-tabulations", avant: corrigee.slice(0, 80), apres: corrigee.replace(/\t/g, "  ").slice(0, 80) });
      corrigee = corrigee.replace(/\t/g, "  ");
    }

    // Y2 : « clé: valeur » — deux-points SANS espace suivant (hors URLs et
    // heures : le remplacement est refusé si un « // » suit ou si le contexte
    // ressemble à http(s): ou 12:34).
    corrigee = corrigerDeuxPoints(corrigee, numero, journal);

    // Y3 : guillemet simple/double non fermé EN FIN de ligne (valeur ligue).
    corrigee = corrigerGuillemetFermant(corrigee, numero, journal);

    return corrigee;
  });

  // Y4 (docker-compose) : indentation des items de liste à 2 espaces
  // sous leur clé ("- port: 80" collé → "  - port: 80") — passe bornée :
  // uniquement les lignes commençant par "- " après une ligne clé:.
  const normalisee = type === "docker-compose" ? corrigerIndentationCompose(sortie, journal) : sortie;
  return normalisee.join("\n");
}

function corrigerDeuxPoints(ligne: string, numero: number, journal: Reparation[]): string {
  // Matche « clé:valeur » : un mot, deux-points, PAS d'espace, lettre/"/.
  // Exclusions : URL (://), heure (digits:digits), plage YAML (a:b impossible
  // car on exige un caractère alphanumérique directement après ":" ET avant).
  const corrige = ligne.replace(/(^|\s)([A-Za-z_][A-Za-z0-9_.-]*):(?!\/)(\S)/g, (tout, prefixe: string, cle: string, suivant: string) => {
    if (/\d:/.test(cle + ":" + suivant) && /^\d$/.test(suivant) && /^\d+$/.test(cle.slice(-1))) {
      return tout; // heure 12:34 — inchangée
    }
    journal.push({ ligne: numero, passe: "yaml-deux-points", avant: ligne.trim().slice(0, 80), apres: ligne.replace(cle + ":" + suivant, cle + ": " + suivant).trim().slice(0, 80) });
    return `${prefixe}${cle}: ${suivant}`;
  });
  return corrige;
}

function corrigerGuillemetFermant(ligne: string, numero: number, journal: Reparation[]): string {
  const guillemetsSimples = (ligne.match(/'/g) ?? []).length;
  const guillemetsDoubles = (ligne.match(/"/g) ?? []).length;
  // Une seule valeur en fin de ligne avec un nombre impair : on ferme.
  if (guillemetsSimples % 2 === 1 && guillemetsDoubles === 0) {
    journal.push({ ligne: numero, passe: "yaml-guillemet", avant: ligne.slice(0, 80), apres: (ligne + "'").slice(0, 80) });
    return ligne + "'";
  }
  if (guillemetsDoubles % 2 === 1 && guillemetsSimples === 0) {
    journal.push({ ligne: numero, passe: "yaml-guillemet", avant: ligne.slice(0, 80), apres: (ligne + '"').slice(0, 80) });
    return ligne + '"';
  }
  return ligne;
}

/** Items « - x » sous une clé : indentés à (profondeur clé + 2). */
function corrigerIndentationCompose(lignes: readonly string[], journal: Reparation[]): string[] {
  const sortie = [...lignes];
  for (let i = 1; i < sortie.length; i++) {
    const ligne = sortie[i];
    const matchItem = /^(\s*)-\s/.exec(ligne);
    const precedente = sortie[i - 1];
    const matchCle = /^(\s*)([A-Za-z_][A-Za-z0-9_-]*):\s*(?:$|#)/.exec(precedente);
    if (matchItem && matchCle) {
      const indentationCle = matchCle[1].length;
      const indentationItem = matchItem[1].length;
      const attendu = indentationCle + 2;
      if (indentationItem <= indentationCle) {
        const corrigee = " ".repeat(attendu) + ligne.trimStart();
        journal.push({
          ligne: i + 1,
          passe: "compose-indentation",
          avant: ligne.trim().slice(0, 80),
          apres: corrigee.trim().slice(0, 80),
        });
        sortie[i] = corrigee;
      }
    }
  }
  return sortie;
}

/* -------------------------------- nginx ----------------------------------- */

function passeNginx(texte: string, journal: Reparation[]): string {
  const lignes = texte.split("\n");
  const sortie = lignes.map((ligne, index) => {
    const nettoye = ligne.trim();
    if (!nettoye || nettoye.startsWith("#")) return ligne;

    // N1 : directive simple non terminée par ; — on l'ajoute si la ligne
    // contient des mots, ne finit ni par { } ; ni par un commentaire.
    if (!/[{};]\s*(#.*)?$/.test(nettoye)) {
      // Exclusions : lignes de continuation évidentes (fin de valeur parenthésée,
      // regex bash-style) — conservatisme : on ne touche que les lignes simples.
      const sansCommentaire = nettoye.replace(/#.*$/, "").trim();
      if (sansCommentaire && !/[{};]$/.test(sansCommentaire) && /^[A-Za-z_]/.test(sansCommentaire)) {
        journal.push({ ligne: index + 1, passe: "nginx-point-virgule", avant: sansCommentaire.slice(0, 80), apres: (sansCommentaire + ";").slice(0, 80) });
        return ligne.replace(sansCommentaire, sansCommentaire + ";");
      }
    }
    return ligne;
  });
  return sortie.join("\n");
}
