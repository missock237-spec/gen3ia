import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import winston from "winston";

/**
 * PIPELINE DE COLLECTE — LocalScraperPipeline
 *
 * Implémentation du guide « Pipeline Production Scraper — Data AI
 * Collection » adaptée à un VPS 2 Go où le serveur d'inférence gen3ia
 * reste PRIORITAIRE :
 *   · moteur HTTP natif (fetch) par défaut — zéro Chromium, ~60 Mo de
 *     RAM, parfait pour les pages statiques (Wikipédia, blogs, docs) ;
 *   · moteur Puppeteer (headless, interception des assets lourds, User-
 *     Agent rotatif) UNIQUEMENT pour les cibles « requiresJs » — chargé
 *     par import dynamique, dégradation gracieuse si non installé
 *     (npm i puppeteer dans services/pipeline/ pour l'activer) ;
 *   · déduplication SHA-256 persistée (cache_hashes.json) : jamais de
 *     re-scraping ni de doublon dans le JSONL ;
 *   · écriture APPEND-ONLY (une ligne = un document, fs.appendFile) :
 *     stockage atomique garanti — aucune lecture du serveur ne peut
 *     corrompre une ligne en cours d'écriture ;
 *   · rate limit / politesse par cible.
 *
 * Le daemon ne contacte JAMAIS la base gen3ia : il produit uniquement le
 * fichier JSONL partagé (découplage total, cf. README.md).
 */

export interface TargetConfig {
  url: string;
  selectorsToRemove?: string[];
  customSelector?: string;
  rateLimitMs?: number;
  /** Force le moteur navigateur (pages rendues côté client). */
  requiresJs?: boolean;
}

export interface ExtractedData {
  id: string;
  url: string;
  title: string;
  content: string;
  scrapedAt: string;
  metadata: {
    wordCount: number;
    language?: string;
    httpStatus: number;
    engine: "fetch" | "puppeteer";
  };
}

/** Pool de User-Agents (rotation, politesse anti-blocage). */
const USER_AGENTS = [
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
];

/** Logger production : console + fichiers (logs/error.log, logs/combined.log). */
export function createLogger(logsDir: string): winston.Logger {
  return winston.createLogger({
    level: "info",
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json(),
    ),
    transports: [
      new winston.transports.Console(),
      new winston.transports.File({ filename: join(logsDir, "error.log"), level: "error" }),
      new winston.transports.File({ filename: join(logsDir, "combined.log") }),
    ],
  });
}

/** Délai aléatoire humanisé (±30 %) autour d'une base en ms. */
function delaiJitter(baseMs: number): number {
  const jitter = baseMs * 0.3;
  return Math.max(250, Math.round(baseMs + (Math.random() * 2 - 1) * jitter));
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * NETTOYAGE HTML côté Node (moteur fetch, sans navigateur) :
 * élimination du DOM parasite (scripts, styles, nav, pubs…) puis
 * extraction du texte brut — équivalent de la passe page.evaluate du
 * guide, adapté à un traitement par regex conservateur.
 */
export function htmlToText(
  html: string,
  selectorsToRemove: string[] = [],
  customSelector?: string,
): string {
  let texte = html;

  // Zone ciblée : extraction conservative du premier bloc correspondant
  // (id="…" ou class="…") — suffisant pour Wikipédia (#mw-content-text).
  if (customSelector) {
    const idMatch = customSelector.match(/^#([\w-]+)$/);
    const classMatch = customSelector.match(/^\.([\w-]+)$/);
    const pattern = idMatch
      ? new RegExp(`<([a-z0-9]+)[^>]*\\bid=["']${idMatch[1]}["'][^>]*>([\\s\\S]*?)</\\1>`, "i")
      : classMatch
        ? new RegExp(`<([a-z0-9]+)[^>]*\\bclass=["'][^"']*${classMatch[1]}[^"']*["'][^>]*>([\\s\\S]*?)</\\1>`, "i")
        : null;
    const zone = pattern ? texte.match(pattern) : null;
    if (zone) texte = zone[2];
  }

  // Blocs entièrement supprimés (contenu sensible aux scripts/styles).
  const blocsPurge = [
    "script", "style", "noscript", "iframe", "svg", "form", "template",
    "header", "footer", "nav", "aside", "object", "embed",
  ];
  for (const tag of blocsPurge) {
    texte = texte.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, "gi"), " ");
  }
  texte = texte.replace(/<!--[\s\S]*?-->/g, " ");

  // Sélecteurs CSS simples (#id / .class) fournis par la cible.
  for (const selecteur of [...selectorsToRemove]) {
    const idMatch = selecteur.match(/^#([\w-]+)$/);
    const classMatch = selecteur.match(/^\.([\w-]+)$/);
    if (idMatch) {
      texte = texte.replace(new RegExp(`<([a-z0-9]+)[^>]*\\bid=["']${idMatch[1]}["'][^>]*>[\\s\\S]*?</\\1>`, "gi"), " ");
    } else if (classMatch) {
      texte = texte.replace(new RegExp(`<([a-z0-9]+)[^>]*\\bclass=["'][^"']*${classMatch[1]}[^"']*["'][^>]*>[\\s\\S]*?</\\1>`, "gi"), " ");
    }
  }

  // Titres conservés comme séparateurs sémantiques, balises restantes
  // supprimées, entités décodées (PASSE UNIQUE : un remplacement par
  // entité via callback — une chaîne de .replace() séquentiels peut
  // produire du double-unescaping, alerte CodeQL), espaces normalisés.
  const ENTITES: Record<string, string> = {
    nbsp: " ",
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    "#39": "'",
    "#039": "'",
    rsquo: "\u2019",
    laquo: "\u00ab",
    raquo: "\u00bb",
  };
  texte = texte
    .replace(/<h([1-6])\b[^>]*>/gi, "\n\n")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<(p|div|li|tr|br|section|article)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(nbsp|amp|lt|gt|quot|#039|#39|rsquo|laquo|raquo);/gi, (entite: string) => {
      const cle = entite.slice(1, -1).toLowerCase();
      return ENTITES[cle] ?? entite;
    })
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return texte;
}

/** Titre <title> d'une page HTML. */
export function extraireTitre(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].replace(/\s+/g, " ").trim() : "";
}

/**
 * Types structurels minimaux de l'API Puppeteer (le paquet est OPTIONNEL
 * et jamais installé en CI) — seul le sous-ensemble utilisé ici est déclaré.
 */
interface PuppeteerRequest {
  resourceType: () => string;
  abort: () => Promise<void>;
  continue: () => Promise<void>;
}
interface PuppeteerPage {
  setRequestInterception: (v: boolean) => Promise<void>;
  on: (event: string, handler: (request: PuppeteerRequest) => void) => void;
  setUserAgent: (userAgent: string) => Promise<void>;
  goto: (url: string, options?: Record<string, unknown>) => Promise<{ status: () => number } | null>;
  evaluate: <A extends unknown[], T>(pageFunction: (...args: A) => T, ...args: A) => Promise<T>;
  title: () => Promise<string>;
  close: () => Promise<void>;
}
interface PuppeteerBrowser {
  newPage: () => Promise<PuppeteerPage>;
  close: () => Promise<void>;
}
interface PuppeteerModule {
  launch: (options?: Record<string, unknown>) => Promise<PuppeteerBrowser>;
}

/**
 * Instance Puppeteer chargée paresseusement (UNIQUEMENT si une cible
 * requiresJs existe ET que le paquet est installé). Absence = dégradation
 * gracieuse (les cibles requiresJs sont sautées avec un avertissement).
 */
let puppeteerCache: PuppeteerModule | null | undefined;

async function chargerPuppeteer(logger: winston.Logger): Promise<PuppeteerModule | null> {
  if (puppeteerCache !== undefined) return puppeteerCache;
  try {
    const specifier = process.env.PIPELINE_PUPPETEER_MODULE || "puppeteer";
    // Import dynamique NON littéral : le module est optionnel, son
    // absence ne doit être ni une erreur de build ni un crash runtime.
    const mod = (await import(specifier)) as { default?: PuppeteerModule } & Partial<PuppeteerModule>;
    const puppeteer = (mod.default ?? mod) as PuppeteerModule;
    if (typeof puppeteer.launch !== "function") throw new Error("API launch absente");
    puppeteerCache = puppeteer;
    logger.info("Moteur Puppeteer disponible (cibles requiresJs activées).");
  } catch {
    puppeteerCache = null;
    logger.warn(
      "Puppeteer non installé — cibles requiresJs ignorées (moteur fetch uniquement).",
    );
  }
  return puppeteerCache;
}

export class LocalScraperPipeline {
  private processedHashes: Set<string> = new Set();
  private readonly outputPath: string;
  private readonly hashCachePath: string;
  private readonly logger: winston.Logger;
  private puppeteerBrowser: PuppeteerBrowser | null = null;

  constructor(
    dataDir: string,
    logsDir: string,
    outputFilename: string = "output.jsonl",
  ) {
    this.outputPath = join(dataDir, outputFilename);
    this.hashCachePath = join(dataDir, "cache_hashes.json");
    this.logger = createLogger(logsDir);
  }

  public get log(): winston.Logger {
    return this.logger;
  }

  public async initialize(): Promise<void> {
    await fs.mkdir(dirname(this.outputPath), { recursive: true });
    await fs.mkdir(dirname(this.hashCachePath), { recursive: true });
    await this.loadHashCache();
    this.logger.info(
      `Pipeline initialisé (sortie: ${this.outputPath}, empreintes en cache: ${this.processedHashes.size}).`,
    );
  }

  private async loadHashCache(): Promise<void> {
    try {
      const data = await fs.readFile(this.hashCachePath, "utf-8");
      const hashes: string[] = JSON.parse(data);
      this.processedHashes = new Set(hashes);
    } catch {
      this.logger.info("Aucun cache d'empreintes existant — démarrage à chaud.");
    }
  }

  private async saveHashCache(): Promise<void> {
    // Écriture ATOMIQUE (tmp au nom IMPRÉVISIBLE + rename) : un crash en
    // cours de sauvegarde ne corrompt jamais le cache précédent, et
    // aucun concurrent ne peut renommer notre tmp partiel.
    const tmp = `${this.hashCachePath}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(Array.from(this.processedHashes)), "utf-8");
    await fs.rename(tmp, this.hashCachePath);
  }

  private generateHash(content: string): string {
    return createHash("sha256").update(content, "utf-8").digest("hex");
  }

  /** Récupération HTML : moteur fetch (statique) OU Puppeteer (requiresJs). */
  private async recupererHtml(
    target: TargetConfig,
  ): Promise<{ html: string; titre: string; httpStatus: number; engine: "fetch" | "puppeteer" } | null> {
    if (!target.requiresJs) {
      const reponse = await fetch(target.url, {
        headers: {
          "User-Agent": USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
          "Accept-Language": "fr,en;q=0.8",
          Accept: "text/html,application/xhtml+xml",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });
      if (!reponse.ok) {
        this.logger.error(`Échec HTTP ${reponse.status} pour l'URL : ${target.url}`);
        return null;
      }
      const html = await reponse.text();
      return { html, titre: extraireTitre(html), httpStatus: reponse.status, engine: "fetch" };
    }

    const puppeteer = await chargerPuppeteer(this.logger);
    if (!puppeteer) return null;

    if (!this.puppeteerBrowser) {
      this.puppeteerBrowser = await puppeteer.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--disable-gpu",
        ],
      });
      this.logger.info("Instance Chromium initialisée (moteur Puppeteer).");
    }
    const page: PuppeteerPage = await this.puppeteerBrowser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (requete: PuppeteerRequest) => {
      const type = requete.resourceType();
      if (["image", "stylesheet", "font", "media"].includes(type)) {
        void requete.abort();
      } else {
        void requete.continue();
      }
    });
    await page.setUserAgent(USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]);
    const reponse = await page.goto(target.url, { waitUntil: "networkidle2", timeout: 30_000 });
    const httpStatus = reponse?.status() ?? 0;
    if (httpStatus >= 400) {
      this.logger.error(`Échec HTTP ${httpStatus} pour l'URL : ${target.url}`);
      await page.close();
      return null;
    }
    const brut = await page.evaluate(
      (selectorsToRemove: string[], customSelector?: string) => {
        const defauts = ["script", "style", "noscript", "iframe", "header", "footer", "nav", "aside", ".ads", ".cookie-banner"];
        for (const selecteur of [...defauts, ...(selectorsToRemove || [])]) {
          document.querySelectorAll(selecteur).forEach((el) => el.remove());
        }
        const conteneur = customSelector
          ? document.querySelector(customSelector)
          : document.body;
        return conteneur ? (conteneur as HTMLElement).innerText : "";
      },
      target.selectorsToRemove ?? [],
      target.customSelector,
    );
    const titre = await page.title();
    await page.close();
    return { html: brut, titre: titre.trim(), httpStatus, engine: "puppeteer" };
  }

  /**
   * Traite une cible : récupération, nettoyage, déduplication SHA-256,
   * append JSONL. Retourne true si un NOUVEAU document a été extrait.
   */
  public async processTarget(target: TargetConfig): Promise<boolean> {
    try {
      const resultat = await this.recupererHtml(target);
      if (!resultat) return false;

      const cleanedContent = (
        resultat.engine === "puppeteer"
          ? resultat.html
          : htmlToText(resultat.html, target.selectorsToRemove ?? [], target.customSelector)
      )
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      if (!cleanedContent) {
        this.logger.warn(`Contenu vide pour ${target.url}`);
        return false;
      }

      const contentHash = this.generateHash(cleanedContent);
      if (this.processedHashes.has(contentHash)) {
        this.logger.info(
          `Contenu dupliqué ignoré (SHA256: ${contentHash.substring(0, 8)}…) pour ${target.url}`,
        );
        return false;
      }

      const wordCount = cleanedContent.split(/\s+/).length;
      const record: ExtractedData = {
        id: contentHash,
        url: target.url,
        title: (resultat.titre || target.url).trim(),
        content: cleanedContent,
        scrapedAt: new Date().toISOString(),
        metadata: { wordCount, httpStatus: resultat.httpStatus, engine: resultat.engine },
      };

      // Écriture ATOMIQUE append-only (une ligne = un document).
      await fs.appendFile(this.outputPath, JSON.stringify(record) + "\n", "utf-8");
      this.processedHashes.add(contentHash);
      await this.saveHashCache();

      this.logger.info(
        `Extraction réussie pour ${target.url} [Mots: ${wordCount}, moteur: ${resultat.engine}]`,
      );

      if (target.rateLimitMs) {
        await delay(delaiJitter(target.rateLimitMs));
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Erreur sur l'URL ${target.url}: ${message}`);
      return false;
    }
  }

  public async close(): Promise<void> {
    if (this.puppeteerBrowser) {
      await this.puppeteerBrowser.close().catch(() => undefined);
      this.puppeteerBrowser = null;
      this.logger.info("Instance Chromium fermée avec succès.");
    }
  }
}
