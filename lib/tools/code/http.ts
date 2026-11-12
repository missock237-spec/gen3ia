import "server-only";

import { z } from "zod";

import { assertPublicHttpUrl } from "@/lib/security/url-safety";

import type { ToolDefinition } from "../types";

/**
 * OUTIL `web.http` — requête HTTP sortante (GET/POST/HEAD).
 *
 * Réutilise la garde SSRF EXISTANTE de la plateforme
 * (lib/security/url-safety → assertPublicHttpUrl : refuse localhost,
 * 127.0.0.1, 10.x, 172.16–31.x, 192.168.x, 169.254.x, [::1], 0.0.0.0 et
 * tout protocole non http(s), plus les identifiants intégrés à l'URL et les
 * hôtes résolvant vers une IP privée/réservée) — la même garantie que
 * web.api, PAS une deuxième implémentation.
 *
 * Bornes durcies : timeout 10 s (AbortSignal), réponse lue en flux avec
 * plafond 2 Mo (au-delà : coupe nette + drapeau `tronque`), redirections
 * revalidées par la garde SSRF à CHAQUE saut (3 maximum), corps restitué
 * honnêtement (statut non-2xx = réponse telle quelle, jamais d'invention).
 */

const TIMEOUT_MS = 10_000;
const TAILLE_MAX_OCTETS = 2_000_000;
const MAX_REDIRECTIONS = 3;
const CORPS_MAX_CARACTERES = 1_000_000;

const EnteteSchema = z
  .record(z.string().min(1).max(200), z.string().max(2000))
  .refine((v) => Object.keys(v).length <= 10, "10 en-têtes maximum");

const EntreeWebHttp = z
  .object({
    url: z.string().trim().url().max(2000),
    methode: z.enum(["GET", "POST", "HEAD"]).default("GET"),
    entetes: EnteteSchema.optional(),
    corps: z
      .union([z.string().max(CORPS_MAX_CARACTERES), z.record(z.string(), z.unknown())])
      .optional(),
  })
  .superRefine((valeur, ctxZod) => {
    if (valeur.corps !== undefined && valeur.methode !== "POST") {
      ctxZod.addIssue({
        code: "custom",
        message: "corps uniquement autorisé pour la méthode POST (GET/HEAD sont sans corps)",
        path: ["corps"],
      });
    }
  });

export interface SortieWebHttp {
  methode: "GET" | "POST" | "HEAD";
  url: string;
  urlFinale: string;
  ok: boolean;
  statut: number;
  statutTexte: string;
  /** Corps réel tronqué au plafond (texte). */
  corps?: string;
  /** JSON parsé si le content-type est JSON et le corps parsable. */
  json?: unknown;
  contentType?: string;
  tailleOctets: number;
  /** Vrai si la réponse a dépassé 2 Mo et a été coupée. */
  tronque: boolean;
  latenceMs: number;
}

export class WebHttpErreur extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebHttpErreur";
  }
}

/** Construit l'URL puis applique la garde SSRF existante. */
async function urlGardee(valeur: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(valeur);
  } catch {
    throw new WebHttpErreur(`URL invalide : ${valeur.slice(0, 500)}`);
  }
  try {
    await assertPublicHttpUrl(url.toString());
  } catch (erreur) {
    throw new WebHttpErreur(
      `URL non autorisée (${url.toString()}) : ${erreur instanceof Error ? erreur.message : "erreur"}`,
    );
  }
  return url;
}

/** Lit le corps en flux avec plafond dur (coupe au-delà de TAILLE_MAX_OCTETS). */
async function lireCorpsBorne(reponse: Response): Promise<{ texte: string; tailleOctets: number; tronque: boolean }> {
  const lecteur = reponse.body?.getReader();
  if (!lecteur) return { texte: "", tailleOctets: 0, tronque: false };
  const morceaux: Uint8Array[] = [];
  let total = 0;
  let tronque = false;
  for (;;) {
    const { done, value } = await lecteur.read();
    if (done) break;
    if (!value) continue;
    if (total + value.byteLength <= TAILLE_MAX_OCTETS) {
      morceaux.push(value);
      total += value.byteLength;
      continue;
    }
    const restant = TAILLE_MAX_OCTETS - total;
    if (restant > 0) morceaux.push(value.subarray(0, restant));
    total += Math.min(value.byteLength, restant);
    tronque = true;
    await lecteur.cancel().catch(() => undefined);
    break;
  }
  const decodeur = new TextDecoder("utf-8");
  let texte = "";
  for (const morceau of morceaux) texte += decodeur.decode(morceau, { stream: true });
  texte += decodeur.decode();
  return { texte, tailleOctets: total, tronque };
}

export const outilWebHttp: ToolDefinition<z.infer<typeof EntreeWebHttp>, SortieWebHttp> = {
  id: "web.http",
  name: "web.http",
  description:
    "Exécute une requête HTTP réelle (GET/POST/HEAD) vers une URL PUBLIQUE et renvoie la réponse réelle : statut, corps (JSON parsé si applicable), taille, latence. " +
    "Input : { url: \"https://…\", methode?: \"GET\"|\"POST\"|\"HEAD\", entetes?: {…} (max 10), corps?: string|objet (POST seulement) }. " +
    "Sécurité : garde SSRF de la plateforme (refuse localhost/127.0.0.1/10.x/172.16–31.x/192.168.x/169.254.x/[::1]/0.0.0.0 et non-http(s)), redirections revalidées, timeout strict 10 s, réponse plafonnée à 2 Mo (drapeau tronque au-delà). " +
    "Un statut non-2xx est restitué TEL QUEL (ok=false) — jamais d'invention. Pour la lecture d'une API privée de l'utilisateur, préférer custom_api.call.",
  category: "http",
  risk: "medium",
  inputSchema: EntreeWebHttp,
  async execute(input) {
    const debut = Date.now();
    const urlInitiale = await urlGardee(input.url);

    const entetes: Record<string, string> = { accept: "application/json, text/*;q=0.9, */*;q=0.8" };
    for (const [cle, valeur] of Object.entries(input.entetes ?? {})) {
      if (cle.trim()) entetes[cle.trim().toLowerCase()] = valeur;
    }

    const corpsPost =
      input.methode === "POST" && input.corps !== undefined && input.corps !== null
        ? typeof input.corps === "string"
          ? input.corps
          : JSON.stringify(input.corps)
        : undefined;
    if (corpsPost !== undefined && !entetes["content-type"]) entetes["content-type"] = "application/json";

    let courant = urlInitiale;
    try {
      let reponse: Response | undefined;
      for (let saut = 0; saut <= MAX_REDIRECTIONS; saut += 1) {
        reponse = await fetch(courant, {
          method: input.methode,
          headers: entetes,
          ...(corpsPost !== undefined ? { body: corpsPost } : {}),
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (reponse.status < 300 || reponse.status >= 400) break;
        const location = reponse.headers.get("location");
        if (!location) throw new WebHttpErreur("La cible a renvoyé une redirection sans destination.");
        if (saut === MAX_REDIRECTIONS) throw new WebHttpErreur(`Trop de redirections (${MAX_REDIRECTIONS + 1} maximum).`);
        courant = await urlGardee(new URL(location, courant).toString());
      }
      const finale = reponse;
      if (!finale) throw new WebHttpErreur("Aucune réponse reçue de la cible.");
      const contentType = finale.headers.get("content-type")?.split(";")[0].trim() ?? undefined;
      const lecture =
        input.methode === "HEAD"
          ? { texte: "", tailleOctets: 0, tronque: false }
          : await lireCorpsBorne(finale);
      let json: unknown;
      if (contentType?.includes("json") && lecture.texte) {
        try {
          json = JSON.parse(lecture.texte);
        } catch {
          /* corps JSON invalide : la version texte reste disponible */
        }
      }
      return {
        methode: input.methode,
        url: urlInitiale.toString(),
        urlFinale: courant.toString(),
        ok: finale.ok,
        statut: finale.status,
        statutTexte: finale.statusText,
        ...(lecture.texte ? { corps: lecture.texte } : {}),
        ...(json !== undefined ? { json } : {}),
        ...(contentType ? { contentType } : {}),
        tailleOctets: lecture.tailleOctets,
        tronque: lecture.tronque,
        latenceMs: Date.now() - debut,
      };
    } catch (erreur) {
      if (erreur instanceof WebHttpErreur) throw erreur;
      const raison =
        erreur instanceof Error && (erreur.name === "TimeoutError" || /timeout|aborted/i.test(erreur.message))
          ? `délai dépassé (${Math.round(TIMEOUT_MS / 1000)} s)`
          : erreur instanceof Error
            ? erreur.message
            : "erreur réseau";
      throw new WebHttpErreur(`La requête ${input.methode} ${courant.toString()} a échoué : ${raison}`);
    }
  },
};
