import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { pourcentageDepuis } from "./carte-video-fil-logique";

/**
 * CARRÉ DE PROGRESSION VIDÉO (demande propriétaire 2026-11-13 : « lors de
 * la génération vidéo gen3 n'affiche plus de barre de progression mais il
 * doit afficher un CARRÉ sur lequel il doit y avoir le pourcentage de
 * progression de la création de la vidéo »).
 *
 * Convention du dépôt (cf. components/media/media-progress-frame.test.tsx,
 * components/billing/chariow-widget.test.tsx) : vitest tourne en Node SANS
 * jsdom ni @testing-library/react, et le tsconfig (jsx: "preserve") empêche
 * vitest de transformer un .tsx contenant du JSX — d'où le découpage en
 * media-progress-logic.ts : la logique PURE vit dans
 * carte-video-fil-logique.ts (importée ci-dessous), le composant
 * carte-video-fil.tsx n'est JAMAIS importé ici —
 *
 *  1. la logique PURE (contrat 0..1 → pourcentage borné) est testée par
 *     import direct du module de logique ;
 *  2. le markup du carré (progressbar + pourcentage DANS le carré +
 *     contraste data-contraste + texte sondes conservé) et les styles
 *     .nova-media-carre-* (88 px, niveau montant du bas, mobile 72 px,
 *     prefers-reduced-motion) sont verrouillés structurellement sur les
 *     sources ;
 *  3. la compatibilité SONDES production Python (regex
 *     « Production vidéo[^%]*—[^%]*\((\d{1,3})\s*%\) » lue via .nova-fil,
 *     cf. scripts/verifie-voix-video-production.py) est verrouillée par
 *     (a) la présence du template inchangé dans la source et (b) une
 *     réplique JS de la regex appliquée à un rendu type.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const CARTE = "components/chat/carte-video-fil.tsx";
const LOGIQUE = "components/chat/carte-video-fil-logique.ts";
const CSS = "components/chat/nova-chat.css";
const FIL = "components/chat/nova-chat.tsx";

// Regex des sondes production Python (scripts/verifie-voix-video-production.py:371)
const REGEX_SONDE = /Production vidéo[^%]*—[^%]*\((\d{1,3})\s*%\)/;

describe("pourcentageDepuis — contrat serveur 0..1 → pourcentage borné (logique pure)", () => {
  it("convertit le contrat 0..1 en pourcentage (×100)", () => {
    expect(pourcentageDepuis(0)).toBe(0);
    expect(pourcentageDepuis(0.42)).toBe(42);
    expect(pourcentageDepuis(0.999)).toBe(100);
    expect(pourcentageDepuis(1)).toBe(100);
  });

  it("par défense, une valeur > 1 est déjà un pourcentage (borné 0..100)", () => {
    expect(pourcentageDepuis(42)).toBe(42);
    expect(pourcentageDepuis(100)).toBe(100);
    expect(pourcentageDepuis(140)).toBe(100);
    expect(pourcentageDepuis(-5)).toBe(0);
  });

  it("valeur illisible → null (état indéterminé, plafond conservé)", () => {
    expect(pourcentageDepuis(Number.NaN)).toBeNull();
    expect(pourcentageDepuis(Number.POSITIVE_INFINITY)).toBeNull();
    expect(pourcentageDepuis("42")).toBeNull();
    expect(pourcentageDepuis(null)).toBeNull();
    expect(pourcentageDepuis(undefined)).toBeNull();
  });
});

describe("carré de progression (structurel) — markup du composant", () => {
  const carte = read(CARTE);

  it("plus AUCUNE barre : les classes nova-media-barre* ont disparu", () => {
    expect(carte).not.toContain("nova-media-barre");
    expect(carte).toContain('className="nova-media-carre"');
  });

  it("le carré porte role=progressbar + aria-valuenow/min/max + libellé explicite", () => {
    expect(carte).toContain('role="progressbar"');
    expect(carte).toContain("aria-valuenow={progression}");
    expect(carte).toContain("aria-valuemin={0}");
    expect(carte).toContain("aria-valuemax={100}");
    expect(carte).toContain("aria-label={`Progression de création de la vidéo : ${progression} %`}");
  });

  it("le pourcentage est affiché DANS le carré, par-dessus le niveau", () => {
    const iCarre = carte.indexOf('className="nova-media-carre"');
    const iFinCarre = carte.indexOf("</div>", carte.indexOf("nova-media-carre-pourcentage"));
    expect(iCarre).toBeGreaterThan(-1);
    expect(iFinCarre).toBeGreaterThan(iCarre);
    const blocCarre = carte.slice(iCarre, iFinCarre + "</div>".length);
    expect(blocCarre).toContain('<div className="nova-media-carre-niveau" style={{ height: `${progression}%` }} />');
    expect(blocCarre).toContain('<span className="nova-media-carre-pourcentage">{progression} %</span>');
    // Le texte des sondes reste HORS du carré (figcaption de la figure).
    expect(blocCarre).not.toContain("Production vidéo");
    expect(carte.indexOf("<figcaption>", iFinCarre)).toBeGreaterThan(iFinCarre);
  });

  it("remplissage VERTICAL proportionnel au % (niveau qui monte du bas)", () => {
    expect(carte).toContain('style={{ height: `${progression}%` }}');
    expect(carte).not.toContain("width: `${progression}%`");
  });

  it("contraste calculé via data-contraste (seuil 55 %)", () => {
    expect(carte).toContain('data-contraste={progression < 55 ? "sombre" : "clair"}');
  });

  it("progression monotone conservée : le plafond ne peut que monter", () => {
    expect(carte).toContain("if (pct !== null && pct > plafond.current) plafond.current = pct;");
    expect(carte).toContain("plafond.current = Math.max(plafond.current, 99);");
  });

  it("composant exporté + logique pure externalisée (testable en Node)", () => {
    // Le composant reste exporté nommé et câblé dans le fil nova-chat.
    expect(carte).toContain("export function CarteVideoFil");
    const fil = read(FIL);
    expect(fil).toContain("carte-video-fil");
    expect(fil).toContain("CarteVideoFil");
    // La logique pure vit dans le module externe, consommé par la carte.
    expect(carte).toContain('import { pourcentageDepuis } from "./carte-video-fil-logique";');
    expect(read(LOGIQUE)).toContain("export function pourcentageDepuis");
  });
});

describe("texte sondes production conservé (compatibilité .nova-fil)", () => {
  const carte = read(CARTE);

  it("le template « Production vidéo — {stage} ({NN} %) » est inchangé", () => {
    expect(carte).toContain('Production vidéo {etat.type === "progression" ? `— ${etat.stage} (${progression} %)` : "— chargement du lecteur…"}');
  });

  it("un rendu type satisfait la regex des sondes Python", () => {
    const rendu = `Production vidéo — montage et rendu (${42} %)`;
    const match = rendu.match(REGEX_SONDE);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe("42");
  });
});

describe("styles nova-chat.css — .nova-media-carre-* (structurel)", () => {
  const css = read(CSS);

  it("carré 88×88 px (aspect-ratio 1/1, coins légers), anciennes classes supprimées", () => {
    expect(css).not.toContain("nova-media-barre");
    const iCarre = css.indexOf(".nova-media-carre {");
    expect(iCarre).toBeGreaterThan(-1);
    const regleCarre = css.slice(iCarre, css.indexOf("}", iCarre));
    expect(regleCarre).toContain("width: 88px;");
    expect(regleCarre).toContain("aspect-ratio: 1 / 1;");
    expect(regleCarre).toContain("border-radius: 10px;");
    expect(regleCarre).toContain("overflow: hidden;");
  });

  it("variables de thème conservées (--g3-border / --g3-accent, comme l'ancienne barre)", () => {
    expect(css).toContain("background: var(--g3-border);");
    expect(css).toContain("background: var(--g3-accent, #6c5ce7);");
    expect(css).toContain("border: 1px solid var(--g3-border-strong);");
  });

  it("niveau : remplissage DU BAS vers le haut avec transition de hauteur", () => {
    const iNiveau = css.indexOf(".nova-media-carre-niveau {");
    expect(iNiveau).toBeGreaterThan(-1);
    const regleNiveau = css.slice(iNiveau, css.indexOf("}", iNiveau));
    expect(regleNiveau).toContain("inset: auto 0 0 0;");
    expect(regleNiveau).toContain("transition: height 1.2s ease;");
  });

  it("pourcentage : gros chiffre semi-bold centré dans le carré", () => {
    const iPct = css.indexOf(".nova-media-carre-pourcentage {");
    expect(iPct).toBeGreaterThan(-1);
    const reglePct = css.slice(iPct, css.indexOf("}", iPct));
    expect(reglePct).toContain("font-weight: 600;");
    expect(reglePct).toContain("align-items: center;");
  });

  it("contraste : blanc sur pastille sombre (< 55 %), sombre sur pastille claire (≥ 55 %)", () => {
    const iSombre = css.indexOf('.nova-media-carre[data-contraste="sombre"] .nova-media-carre-pourcentage {');
    const iClair = css.indexOf('.nova-media-carre[data-contraste="clair"] .nova-media-carre-pourcentage {');
    expect(iSombre).toBeGreaterThan(-1);
    expect(iClair).toBeGreaterThan(iSombre);
    expect(css.slice(iSombre, css.indexOf("}", iSombre))).toContain("color: #ffffff;");
    expect(css.slice(iClair, css.indexOf("}", iClair))).toContain("color: #101b26;");
  });

  it("responsive mobile (breakpoint 640 px du fichier) : carré ~72 px", () => {
    const iMobile = css.indexOf("@media (max-width: 640px) {", css.indexOf(".nova-media-carre"));
    expect(iMobile).toBeGreaterThan(-1);
    const i72 = css.indexOf(".nova-media-carre { width: 72px; }", iMobile);
    const iFonte = css.indexOf(".nova-media-carre-pourcentage { font-size: 0.95rem; }", iMobile);
    expect(i72).toBeGreaterThan(iMobile);
    expect(iFonte).toBeGreaterThan(i72);
  });

  it("prefers-reduced-motion : aucune animation (transition du niveau désactivée)", () => {
    const iReduce = css.indexOf("@media (prefers-reduced-motion: reduce) {", css.indexOf(".nova-media-carre"));
    expect(iReduce).toBeGreaterThan(-1);
    expect(css.indexOf(".nova-media-carre-niveau { transition: none; }", iReduce)).toBeGreaterThan(iReduce);
  });

  it("texte sondes à côté du carré : figcaption fluide dans la ligne flex", () => {
    expect(css).toContain(".nova-media-carte.nova-media-carte-progress {");
    expect(css).toContain(".nova-media-carte.nova-media-carte-progress figcaption {");
  });
});

describe("lecteur durable direct (fix 2026-11-13 « la vidéo n'est jamais envoyée »)", () => {
  const carte = read(CARTE);

  it("le statut de production porte le lecteur durable (st.masterUrl) → état « prete » SANS détour", () => {
    // La carte consomme l'URL durable RELATIVE exposée par GET .../production
    // — un seul saut (cookie de session automatique), plus de dépendance à la
    // chaîne GET .../render + présignature R2 qui laissait la carte figée sur
    // « finalisation (100 %) » en production.
    expect(carte).toContain("masterUrl");
    expect(carte).toContain('return { type: "prete", url: st.masterUrl };');
  });

  it("sans masterUrl dans la réponse → repli historique sur la résolution GET .../render", () => {
    expect(carte).toContain('return { type: "chargement" }; // lecteur résolu séparément');
    expect(carte).toContain("resoudreLecteur");
  });

  it("l'URL du lecteur reste CONSOMMÉE TELLE QUELLE par <video src> (aucune réécriture locale)", () => {
    expect(carte).toContain('<video src={etat.url} controls preload="metadata" className="nova-media-video" />');
  });

  it("le parseur SSE porte aussi le champ masterUrl (contrat d'événement aligné)", () => {
    expect(carte).toContain("masterUrl?: string | null");
  });
});
