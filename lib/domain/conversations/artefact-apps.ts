import type { ConversationArtifact } from "./types";
import { isRunnableHtmlApp } from "./app-detect";

/**
 * ARTEFACTS GEN3IA — pages web et graphiques exécutables.
 *
 * L'utilisateur demande en langage naturel (« crée une page web de liste de
 * tâches en mode sombre, écrite en React ») : Gen3ia produit un ARTEFACT
 * complet (page HTML autonome) accompagné d'un LIEN WEB (/preview/<id>) qui
 * rend le résultat directement dans le navigateur. Même mécanisme pour les
 * graphiques d'analyse de données (ECharts, export PNG/JPG intégré).
 *
 * Détections 100 % déterministes (zéro LLM) : le comportement est stable,
 * auditable et ne dépend d'aucun fournisseur.
 */

/* ------------------------------------------------------------------ */
/* 1) Détection — création d'une page web / petite application         */
/* ------------------------------------------------------------------ */

export interface AppCreationIntent {
  /** Titre lisible extrait de la demande (80 caractères max). */
  title: string;
  /** L'utilisateur demande explicitement React. */
  wantsReact: boolean;
  /** Thème énoncé (sombre / clair) ou automatique. */
  theme: "dark" | "light" | "auto";
}

/** Verbe de création (testé sur le texte SANS accents — l'apparition d'un objet web est exigée EN PLUS). */
const APP_VERB_RE =
  /\b(?:cree?s?|creer|creez|genere[srz]?|generer|developpe[srz]?|developper|construis|construire|fabrique[rz]?|code[rz]?|programme[rz]?|ecris|ecrire|concois|concevoir|imagine[rz]?|produis|produire|realise[rz]?|fais[- ]moi|faites[- ]moi|aide(?:z)?[- ]moi\s+(?:a|à)\s+(?:creer|generer|developper|construire|coder|realiser))\b/i;

/** Objet web/application (l'un de ces marqueurs est requis) — texte sans accents. */
const APP_OBJECT_RE =
  /\b(?:page\s+web|site\s+web|site\s+vitrine|page\s+internet|page\s+d['']accueil|landing\s*page|application(?:\s+web)?|app\s+web|web\s*app|interface(?:\s+utilisateur)?|tableau\s+de\s+bord|dashboard|portfolio|formulaire|liste\s+de\s+taches|to[- ]?do(?:\s+list)?|checklist|calculatrice|calculateur|convertisseur|jeu\s+(?:de|en)?|quiz|questionnaire|minuteur|chronometre|horloge|planning|calendrier|galerie|lecteur|menu\s+du\s+jour|page\s+d[''][a-z]{2,})\b/i;

/** Demandes relevant d'AUTRES tours (documents, images, emails) : JAMAIS une app — texte sans accents. */
const APP_EXCLUSION_RE =
  /\b(?:presentation|diaporama|powerpoint|pptx|rapport|compte[- ]rendu|pdf|docx|word|excel|xlsx|csv|e[- ]?mail|mail\s+[àa]|photo(?:graphie)?|dessin|logo|affiche|poster|video|image|illustration|banner|banniere)\b/i;

/** Minuscules + suppression des accents (NFD) : « Crée » ≡ « cree », « données » ≡ « donnees ». */
function normalizeForDetection(message: string): string {
  return message.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function detectAppCreationIntent(message: string): AppCreationIntent | null {
  const lower = normalizeForDetection(message);
  if (!APP_VERB_RE.test(lower) || !APP_OBJECT_RE.test(lower)) return null;
  // Les documents/images/emails restent sur leurs tours dédiés.
  if (APP_EXCLUSION_RE.test(lower)) return null;

  const wantsReact = /\breact(?:\.?js|js)?\b|\bjsx\b/i.test(message);
  const theme: AppCreationIntent["theme"] = /\bsombre|dark\b/i.test(lower)
    ? "dark"
    : /\bclair|light\b/i.test(lower)
      ? "light"
      : "auto";

  return { title: extractAppTitle(message), wantsReact, theme };
}

/** Titre lisible : supprime les formules d'introduction, garde l'essentiel. */
export function extractAppTitle(message: string): string {
  const cleaned = message
    .replace(/\b(?:agent\s+ia|assistant|stp|s'il\s+te\s+pla[îi]t|merci)\b/gi, "")
    .replace(/\b(?:aide(?:z)?[- ]moi\s+(?:a|à)|peux[- ]tu|pourrais[- ]tu|je\s+voudrais|je\s+veux|fais[- ]moi|faites[- ]moi)\b/gi, "")
    .replace(/\b(?:crée[rz]?|créer|génère[rz]?|générer|développe[rz]?|construis|construire|code[rz]?|écris|conçois|imagine|réalise[rz]?)\b/gi, "")
    .replace(/\b(?:une?|le|la|les|de|du|des|d'|pour\s+moi|moi)\b\s*/gi, (match, offset, full) =>
      // « de liste de tâches » : on garde les « de » internes, on coupe seulement en tête.
      offset === 0 || full.slice(0, offset).trim().length === 0 ? "" : match,
    )
    .replace(/\s{2,}/g, " ")
    .replace(/^[,\s-]+|[,\s-]+$/g, "")
    .trim();
  const candidate = cleaned.length >= 4 ? cleaned : message.trim();
  return candidate.slice(0, 80) || "Application web";
}

/* ------------------------------------------------------------------ */
/* 2) Détection — graphique d'analyse de données                       */
/* ------------------------------------------------------------------ */

export interface ChartIntent {
  chartType: "bar" | "line" | "pie";
  title: string;
}

const CHART_OBJECT_RE =
  /\b(?:graphique|chart|diagramme|histogramme|courbe|courbes|camembert|secteurs|circulaire|nuage\s+de\s+points|visualis(?:e|er|ation)|repr[ée]sent(?:e|er|ation)\s+(?:graphique|visuelle)?|analyse\s+(?:ces|ces?|des|du|le|la)\s+donn[ée]es|analyse\s+(?:ce|le|du)\s+fichier)\b/i;

export function detectChartIntent(message: string): ChartIntent | null {
  const lower = normalizeForDetection(message);
  if (!CHART_OBJECT_RE.test(lower)) return null;
  if (APP_EXCLUSION_RE.test(lower)) return null;
  return { chartType: chartTypeFromMessage(message), title: extractChartTitle(message) };
}

export function chartTypeFromMessage(message: string): ChartIntent["chartType"] {
  const lower = message.toLowerCase();
  if (/\b(?:camembert|secteurs|circulaire|r[ée]partition|parts?\b|pourcentages?\b)/i.test(lower)) return "pie";
  if (/\b(?:courbe|courbes|ligne|lin[ée]aire|tendance|évolution|evolution)\b/i.test(lower)) return "line";
  return "bar";
}

function extractChartTitle(message: string): string {
  const explicit = message.match(/\b(?:graphique|diagramme|histogramme|courbe|camembert)\s+(?:de|des|du|d')\s*([^,.;\n]{3,60})/i);
  if (explicit?.[1]) return `Graphique — ${explicit[1].trim()}`;
  return "Graphique de vos données";
}

/* ------------------------------------------------------------------ */
/* 3) Extraction de données (message inline ou fichier importé)        */
/* ------------------------------------------------------------------ */

export interface ChartData {
  labels: string[];
  values: number[];
  /** Provenance honnête, affichée dans l'artefact. */
  source: string;
}

const INLINE_PAIR_RE = /([A-Za-zÀ-ÿ0-9][^:=\n]{0,40}?)\s*[:=]\s*(-?\d+(?:[.,]\d+)?)\s*(?:%|€|\$|k\b|K\b)?(?=\s*(?:,|;|\n|$))/g;

/** Paires « Label: 12 » énoncées directement dans le message (≥ 3 paires). */
export function extractInlineData(message: string): ChartData | null {
  const labels: string[] = [];
  const values: number[] = [];
  for (const match of message.matchAll(INLINE_PAIR_RE)) {
    const label = match[1].trim().replace(/^[-•*\s]+/, "");
    const value = Number(match[2].replace(",", "."));
    if (!label || /^\d+$/.test(label) || !Number.isFinite(value)) continue;
    if (label.length > 40) continue;
    labels.push(label);
    values.push(value);
  }
  if (labels.length < 3) return null;
  return { labels, values, source: "données énoncées dans votre message" };
}

/**
 * Données structurées d'un fichier importé (CSV/XLSX convertis en base) :
 * la 1ʳᵉ colonne fournit les catégories, la 1ʳᵉ colonne numérique les valeurs.
 */
export function chartDataFromTable(headers: string[], rows: string[][], source: string, maxRows = 15): ChartData | null {
  if (!headers.length || !rows.length) return null;
  const numericIndex = headers.findIndex((_, column) => {
    const cells = rows.slice(0, 20).map((row) => row[column]);
    const numeric = cells.filter((cell) => cell !== undefined && cell !== "" && Number.isFinite(Number(String(cell).replace(",", ".").replace(/\s/g, ""))));
    return numeric.length >= Math.max(2, Math.ceil(cells.length * 0.6));
  });
  if (numericIndex < 0) return null;
  const labels: string[] = [];
  const values: number[] = [];
  for (const row of rows) {
    const label = (row[0] ?? "").trim();
    const raw = (row[numericIndex] ?? "").replace(/\s/g, "").replace(",", ".");
    const value = Number(raw);
    if (!label || !Number.isFinite(value)) continue;
    labels.push(label.slice(0, 30));
    values.push(value);
    if (labels.length >= maxRows) break;
  }
  if (labels.length < 2) return null;
  return { labels, values, source };
}

/* ------------------------------------------------------------------ */
/* 4) Artefact graphique — page HTML autonome (ECharts + export)       */
/* ------------------------------------------------------------------ */

/** Échappe le texte injecté dans le HTML (labels provenant de données utilisateur). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildChartHtml(input: {
  title: string;
  chartType: ChartIntent["chartType"];
  labels: string[];
  values: number[];
  source: string;
  conclusion?: string;
}): string {
  const { title, chartType, labels, values, source } = input;
  const data = JSON.stringify({ title, chartType, labels, values }).replace(/</g, "\\u003c");
  const conclusion = input.conclusion?.trim();
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} — Gen3ia</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"></script>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body {
    font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
    background: linear-gradient(160deg, #07080f 0%, #0d0f1d 55%, #12081f 100%);
    color: #eef0ff; min-height: 100vh; padding: 24px 16px 40px;
  }
  .wrap { max-width: 960px; margin: 0 auto; }
  header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; margin-bottom: 14px; }
  h1 { font-size: 20px; letter-spacing: .2px; }
  .src { font-size: 12px; color: #9aa0c3; }
  .actions { display: flex; gap: 10px; margin-bottom: 14px; }
  button {
    font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    color: #fff; background: linear-gradient(135deg, #7c5cff, #e14fea);
    border: 0; border-radius: 999px; padding: 9px 18px;
  }
  button:hover { filter: brightness(1.08); }
  #chart { width: 100%; height: 460px; background: rgba(255,255,255,.03);
    border: 1px solid rgba(255,255,255,.08); border-radius: 16px; }
  .conclusion { margin-top: 18px; line-height: 1.6; font-size: 14px;
    background: rgba(124,92,255,.08); border: 1px solid rgba(124,92,255,.25);
    border-radius: 12px; padding: 14px 16px; }
  footer { margin-top: 22px; text-align: center; font-size: 12px; color: #6f7497; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${escapeHtml(title)}</h1>
    <span class="src">Source : ${escapeHtml(source)}</span>
  </header>
  <div class="actions">
    <button id="dl-png" type="button">Télécharger PNG</button>
    <button id="dl-jpg" type="button">Télécharger JPG</button>
  </div>
  <div id="chart"></div>
  ${conclusion ? `<div class="conclusion"><strong>Analyse :</strong> ${escapeHtml(conclusion)}</div>` : ""}
  <footer>Propulsé par Gen3ia · gen3ia.online</footer>
</div>
<script>
  const payload = ${data};
  const dark = { color: ["#7c5cff", "#e14fea", "#2ad4e8", "#ffc861", "#5effc4"], backgroundColor: "transparent" };
  const base = {
    textStyle: { color: "#c9cdf0", fontFamily: "Segoe UI, system-ui, sans-serif" },
    tooltip: { trigger: "axis", backgroundColor: "#151728", borderColor: "#2a2d4a", textStyle: { color: "#eef0ff" } },
    grid: { left: 48, right: 24, top: 40, bottom: 48 }
  };
  let option;
  if (payload.chartType === "pie") {
    option = { ...dark, ...base,
      tooltip: { trigger: "item", backgroundColor: "#151728", borderColor: "#2a2d4a", textStyle: { color: "#eef0ff" } },
      series: [{ type: "pie", radius: ["38%", "68%"], center: ["50%", "54%"],
        itemStyle: { borderRadius: 8, borderColor: "#0d0f1d", borderWidth: 2 },
        label: { color: "#c9cdf0" }, data: payload.labels.map((l, i) => ({ name: l, value: payload.values[i] })) }] };
  } else {
    option = { ...dark, ...base,
      xAxis: { type: "category", data: payload.labels, axisLabel: { color: "#9aa0c3", rotate: payload.labels.length > 7 ? 30 : 0 },
        axisLine: { lineStyle: { color: "#2a2d4a" } } },
      yAxis: { type: "value", axisLabel: { color: "#9aa0c3" }, splitLine: { lineStyle: { color: "#1c1f36" } } },
      dataZoom: payload.labels.length > 12 ? [{ type: "inside" }] : [],
      series: [Object.assign({
        type: payload.chartType === "line" ? "line" : "bar",
        data: payload.values, smooth: true, barMaxWidth: 56,
        itemStyle: payload.chartType === "line"
          ? { color: "#e14fea", lineWidth: 3 }
          : { borderRadius: [8, 8, 0, 0], color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: "#7c5cff" }, { offset: 1, color: "#e14fea" }]) }
      }, payload.chartType === "line" ? { areaStyle: { color: "rgba(225,79,234,.12)" } } : {
        label: { show: true, position: "top", color: "#9aa0c3", fontSize: 11 }
      })] };
  }
  const chart = echarts.init(document.getElementById("chart"), null, { renderer: "canvas" });
  chart.setOption(option);
  window.addEventListener("resize", () => chart.resize());
  function download(type) {
    const url = chart.getDataURL({ type, pixelRatio: 2, backgroundColor: "#0d0f1d" });
    const a = document.createElement("a");
    a.href = url;
    a.download = payload.title.replace(/[^a-z0-9\-_ ]/gi, "").trim().replace(/\\s+/g, "-").toLowerCase() + "." + type;
    document.body.appendChild(a); a.click(); a.remove();
  }
  document.getElementById("dl-png").addEventListener("click", () => download("png"));
  document.getElementById("dl-jpg").addEventListener("click", () => download("jpg"));
</script>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/* 5) Artefact application — prompt d'extraction + extraction HTML     */
/* ------------------------------------------------------------------ */

export const APP_SYSTEM_PROMPT = [
  "Tu es le générateur d'applications web de Gen3ia. Tu produis UNE page HTML unique, complète et immédiatement exécutable.",
  "RÈGLES ABSOLUES :",
  "1. Ta réponse contient UNIQUEMENT le document HTML, commençant par <!DOCTYPE html> et se terminant par </html>. Aucun texte hors du document, aucun bloc markdown, aucune explication.",
  "2. Fichier unique autonome : CSS dans <style>, JavaScript dans <script>. Aucun fichier local, aucune variable d'environnement, aucune clé d'API.",
  "3. Si React est demandé : utilise React 18 + ReactDOM + Babel Standalone via CDN (unpkg.com) avec <script type=\"text/babel\">. Sinon, JavaScript vanilla moderne.",
  "4. Design PREMIUM niveau produit fini : thème sombre par défaut (fond #07080f-#12081f, dégradés violet #7c5cff → fuchsia #e14fea → cyan #2ad4e8), surfaces translucides, coins arrondis 14-18px, ombres douces, transitions fluides ; thème clair si demandé. Typographie soignée (Segoe UI/system-ui), espacements cohérents, entièrement responsive (mobile inclus).",
  "5. TOUT est fonctionnel : chaque bouton, chaque champ, chaque interaction agit réellement (ajout, suppression, édition, filtre, calcul…). Aucun élément décoratif mort, aucun « TODO ».",
  "6. Les données persistent EN MÉMOIRE uniquement (localStorage indisponible dans l'aperçu sandboxé — jamais d'accès direct sans try/catch). Partir d'un petit jeu de données d'exemple réaliste est permis.",
  "7. Interface en FRANÇAIS (titres, boutons, placeholders, messages). Attributs d'accessibilité de base (label, aria).",
  "8. Aucune requête réseau authentifiée, aucun contenu adulte/illicite. CDN statiques autorisés (polices, React, icônes).",
].join("\n");

export function buildAppUserRequest(message: string, intent: AppCreationIntent): string {
  const parts = [
    `Demande de l'utilisateur : « ${message.slice(0, 2000)} ».`,
    `Produis la page HTML complète correspondante (${intent.wantsReact ? "en React 18 via CDN + Babel" : "en HTML/CSS/JavaScript vanilla"})${intent.theme === "dark" ? ", en MODE SOMBRE" : intent.theme === "light" ? ", en MODE CLAIR" : ""}.`,
    "Souviens-toi : ta réponse = uniquement le document HTML complet, de <!DOCTYPE html> à </html>.",
  ];
  return parts.join("\n");
}

/** Extrait le document HTML de la réponse du modèle (fence markdown ou brut). */
export function extractHtmlDocument(text: string): string | null {
  if (!text) return null;
  const fenced = text.match(/```(?:html)?\s*\n?([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.search(/<!doctype html|<html[\s>]/i);
  if (start < 0) return null;
  const document = candidate.slice(start).trim();
  if (!/<\/html>/i.test(document)) return null;
  const end = document.toLowerCase().lastIndexOf("</html>") + "</html>".length;
  return document.slice(0, end);
}

/* ------------------------------------------------------------------ */
/* 6) Lien web d'aperçu (la fonctionnalité ARTEFACTS)                  */
/* ------------------------------------------------------------------ */

export function previewPathFor(artifact: Pick<ConversationArtifact, "id">): string {
  return `/preview/${artifact.id}`;
}

/** Lien markdown cliquable vers l'aperçu web du rendu. */
export function previewLinkMarkdown(artifact: ConversationArtifact): string {
  const label = artifact.title?.slice(0, 60) || "Aperçu en direct";
  return `[${label}](${previewPathFor(artifact)})`;
}

/**
 * Ajoute au message final les liens d'aperçu de tous les artefacts
 * « applicatifs » (pages HTML exécutables) produits pendant le tour.
 * C'est le contrat ARTEFACTS : un livrable de code → un lien web cliquable
 * qui rend le résultat dans le navigateur.
 */
export function appendPreviewLinks(content: string, artifacts: ConversationArtifact[]): string {
  const apps = artifacts.filter((artifact) => isRunnableHtmlApp(artifact));
  if (apps.length === 0) return content;
  const links = apps
    .map((artifact) => `▶ **Résultat en direct : ${previewLinkMarkdown(artifact)}** — cliquez pour voir le rendu dans votre navigateur.`)
    .join("\n\n");
  return `${content.trimEnd()}\n\n${links}`;
}
