import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  estCleMediaProprietaire,
  estClePermanenteProprietaire,
  urlDurableRelative,
} from "@/lib/media/url-durable";

/**
 * VERROU BIDIRECTIONNEL — LIVRAISON MÉDIA DURABLE DANS LA CONVERSATION.
 *
 * Demande propriétaire (2026-11-12) : « Les vidéos et la génération d'audio
 * ne sont pas réellement créé et envoyé dans la conversation a l'utilisateur
 * corrige sa ».
 *
 * CAUSE RACINE AUDITÉE (réelle, quatre couches) :
 *  1. les messages persistés (voix/vidéo) portent des URL présignées R2
 *     expirables (audio TTL 1 h, master vidéo TTL 900 s) → lien mort après
 *     rechargement : « jamais envoyé » pour l'utilisateur ;
 *  2. ConversationMessage n'a AUCUN champ audio/vidéo structuré → le
 *     rechargement ne peut rien rendre ;
 *  3. l'UI chat n'affiche NI lecteur <audio> NI carte vidéo NI l'event
 *     artifact_created (« UI épurée ») → même à l'instant, rien n'est vu ;
 *  4. VideoProductionCard ne vit que dans /workspace — jamais dans le fil.
 *
 * Ce garde verrouille les DEUX directions :
 *  - LA LIVRAISON RÉELLE : URL durable canonique re-signée à chaque
 *    résolution (route authentifiée, bornée au permanent propriétaire),
 *    champs structurés audioUrl/videoProjectId de bout en bout (types →
 *    dépôt → événements → client), lecteur <audio> + carte vidéo DANS le
 *    fil (SSE production + /render pour l'URL fraîche) ;
 *  - L'HONNÊTETÉ : une clé hors permanent n'est JAMAIS convertie (pas de
 *    media factice), la carte affiche l'échec réel, aucun secret en clair.
 */

const RACINE = path.join(import.meta.dirname, "..", "..");

function lire(relatif: string): string {
  return readFileSync(path.join(RACINE, relatif), "utf8");
}

describe("url durable — helpers purs", () => {
  it("une clé permanente propriétaire produit l'URL canonique relative", () => {
    expect(urlDurableRelative("users/r2_abc/permanent/ai-audio/x.mp3")).toBe(
      "/api/media/durable?path=users%2Fr2_abc%2Fpermanent%2Fai-audio%2Fx.mp3",
    );
  });

  it("une clé HORS permanent n'est jamais convertie (pas de média factice)", () => {
    expect(urlDurableRelative("users/r2_abc/cache/tmp.mp3")).toBeNull();
    expect(urlDurableRelative("https://externe.exemple/audio.mp3")).toBeNull();
    expect(urlDurableRelative(undefined)).toBeNull();
    expect(urlDurableRelative("")).toBeNull();
  });

  it("la traversée de chemin (..) est refusée", () => {
    expect(urlDurableRelative("users/r2_abc/permanent/../../autre/f.mp3")).toBeNull();
  });

  it("une clé VIDÉO du pipeline (users/<uid>/video/…) est résolvable durable", () => {
    const cle = "users/r2_abc/video/proj-1/render/master.mp4";
    expect(urlDurableRelative(cle)).toBe("/api/media/durable?path=users%2Fr2_abc%2Fvideo%2Fproj-1%2Frender%2Fmaster.mp4");
    expect(estCleMediaProprietaire(cle, "r2_abc")).toBe(true);
    expect(estCleMediaProprietaire(cle, "r2_autre")).toBe(false);
  });

  it("une clé hors permanent/ et hors video/ n'est jamais résolvable", () => {
    expect(estCleMediaProprietaire("users/r2_abc/cache/tmp.mp3", "r2_abc")).toBe(false);
    expect(estCleMediaProprietaire("videos/user-1/proj-1/master.mp4", "r2_abc")).toBe(false);
  });

  it("estClePermanenteProprietaire : borne au stockage du propriétaire", () => {
    expect(estClePermanenteProprietaire("users/r2_abc/permanent/ai-audio/x.mp3", "r2_abc")).toBe(true);
    expect(estClePermanenteProprietaire("users/r2_AUTRE/permanent/x.mp3", "r2_abc")).toBe(false);
    expect(estClePermanenteProprietaire("users/r2_abc/cache/x.mp3", "r2_abc")).toBe(false);
    expect(estClePermanenteProprietaire(42, "r2_abc")).toBe(false);
  });

  it("urlDurableAbsolue : ORIGINE CLIENT prioritaire (cookie host-only)", () => {
    vi.stubEnv("GEN3IA_APP_ORIGIN", "https://www.gen3ia.online");
    vi.resetModules();
    return import("@/lib/media/url-durable").then(({ urlDurableAbsolue: absolue }) => {
      expect(absolue("users/r2_abc/permanent/x.mp3", "https://www.gen3ia.online")).toBe(
        "https://www.gen3ia.online/api/media/durable?path=users%2Fr2_abc%2Fpermanent%2Fx.mp3",
      );
      // origine invalide → repli canonique, jamais d'URL falsifiable.
      expect(absolue("users/r2_abc/permanent/x.mp3", "javascript:alert(1)")).toBe(
        "https://www.gen3ia.online/api/media/durable?path=users%2Fr2_abc%2Fpermanent%2Fx.mp3",
      );
      vi.unstubAllEnvs();
    });
  });

  it("urlDurableAbsolue : origine canonique GEN3IA_APP_ORIGIN + chemin relatif", () => {
    vi.stubEnv("GEN3IA_APP_ORIGIN", "https://www.gen3ia.online");
    vi.resetModules();
    // Import frais après le stub d'environnement (resolveJobOrigin lit l'env).
    return import("@/lib/media/url-durable").then(({ urlDurableAbsolue: absolue }) => {
      expect(absolue("users/r2_abc/permanent/ai-audio/x.mp3")).toBe(
        "https://www.gen3ia.online/api/media/durable?path=users%2Fr2_abc%2Fpermanent%2Fai-audio%2Fx.mp3",
      );
      vi.unstubAllEnvs();
    });
  });

  it("urlDurableAbsolue : origine non résolue → null (repli présigné par l'appelant)", () => {
    vi.stubEnv("GEN3IA_APP_ORIGIN", "");
    vi.resetModules();
    return import("@/lib/media/url-durable").then(({ urlDurableAbsolue: absolue }) => {
      expect(absolue("users/r2_abc/permanent/ai-audio/x.mp3")).toBeNull();
      vi.unstubAllEnvs();
    });
  });
});

describe("route /api/media/durable — résolution authentifiée bornée", () => {
  const source = lire("app/api/media/durable/route.ts");

  it("authentification obligatoire (protectRoute) — aucun média public", () => {
    expect(source).toContain("protectRoute(request)");
  });

  it("préfixe propriétaire vérifié avec l'UID de session AVANT résolution", () => {
    expect(source).toContain("estCleMediaProprietaire(path, guard.context.userId)");
  });

  it("les deux familles de clés sont signées (permanent + vidéo)", () => {
    expect(source).toContain("createPermanentDownloadUrl");
    expect(source).toContain("createVideoPlaybackUrl");
  });

  it("re-signature via createPermanentDownloadUrl + redirection 302", () => {
    expect(source).toContain("createPermanentDownloadUrl(guard.context.userId, cle)");
    expect(source).toContain("createVideoPlaybackUrl(guard.context.userId, cle, 600)");
    expect(source).toContain("NextResponse.redirect(url, 302)");
  });
});

describe("contrat du message — champs structurés durables de bout en bout", () => {
  it("ConversationMessage porte audioUrl + videoProjectId", () => {
    const source = lire("lib/domain/conversations/types.ts");
    expect(source).toContain("audioUrl?: string");
    expect(source).toContain("videoProjectId?: string");
  });

  it("le dépôt chat les restaure (rechargement = média toujours vu)", () => {
    const source = lire("lib/chat/repository.ts");
    expect(source).toContain("x.audioUrl");
    expect(source).toContain("x.videoProjectId");
  });

  it("sync-historique mappe les champs serveur → fil local", () => {
    const source = lire("components/chat/sync-historique.ts");
    expect(source).toContain("m.audioUrl");
    expect(source).toContain("m.videoProjectId");
  });
});

describe("chemin VOIX — URL durable dans le texte + champ structuré", () => {
  it("runVoixTurn : urlDurableAbsolue(origineClient) dans le contenu + audioUrl persisté", () => {
    const source = lire("lib/domain/conversations/engine-media.ts");
    expect(source).toContain("urlDurableAbsolue(rendu.cleStockage, ctx.origineClient)");
    expect(source).toContain("urlDurableRelative(rendu.cleStockage)");
    expect(source).toContain("audioUrl: audioUrlDurable");
    expect(source).toContain("origineClient: ctx.origineClient");
  });

  it("les routes résolvent l'origine RÉELLEMENT naviguée (jamais une entrée client, jamais un lien localhost)", () => {
    const stream = lire("app/api/workspace/conversations/[conversationId]/messages/stream/route.ts");
    expect(stream).toContain("origineClient: resolveOrigineClient(request)");
    const api = lire("app/api/workspace/conversations/[conversationId]/messages/route.ts");
    expect(api).toContain("origineClient: resolveOrigineClient(request)");
    const webgpu = lire("app/api/media/webgpu-complete/route.ts");
    expect(webgpu).toContain("urlDurableAbsolue(persisté.storagePath, resolveOrigineClient(request))");
    // CONSTAT PRODUCTION (sonde 2026-11-12 : liens « https://localhost:3000 »
    // derrière nginx) : les quatre routes médias passent par le résolveur
    // allowlisté — plus AUCUN `request.nextUrl.origin` brut sur les liens.
    expect(stream).not.toContain("origineClient: request.nextUrl.origin");
    expect(api).not.toContain("origineClient: request.nextUrl.origin");
    const repli = lire("app/api/media/webgpu-fallback/route.ts");
    expect(repli).toContain("resolveOrigineClient(request)");
  });

  it("le résolveur d'origine est allowlisté et rejette localhost en production", () => {
    const source = lire("lib/media/origine-client.ts");
    expect(source).toContain("isAllowedJobHost");
    expect(source).toContain("x-forwarded-host");
    expect(source).toContain("referer");
    expect(source).toContain('process.env.NODE_ENV === "production"');
  });

  it("le job vidéo porte l'origine du lanceur (livraison en arrière-plan)", () => {
    const job = lire("lib/video/production-job.ts");
    expect(job).toContain("origineClient?: string");
    const queue = lire("lib/video/production-queue.ts");
    expect(queue).toContain("origineClient?: string");
    expect(queue).toContain('url.protocol === "https:" || url.hostname === "localhost"');
    const delivery = lire("lib/video/production-delivery.ts");
    expect(delivery).toContain("urlDurableAbsolue(r2Key, job.origineClient)");
  });

  it("voice.speak : ecouterUrl durable quand la clé permanente existe", () => {
    const source = lire("lib/tools/media/voice-speak.ts");
    expect(source).toContain("urlDurableAbsolue(rendu.cleStockage)");
    expect(source).toContain("ecouterUrl: ecouter");
  });

  it("chemin planner : la sortie voice.speak alimente audioUrl du message final", () => {
    const source = lire("lib/domain/conversations/engine-plan.ts");
    expect(source).toContain("sortieAudioDurable");
    expect(source).toContain("sortieVideoProjectId");
    expect(source).toContain("...(sortieAudioDurable ? { audioUrl: sortieAudioDurable } : {})");
    expect(source).toContain("...(sortieVideoProjectId ? { videoProjectId: sortieVideoProjectId } : {})");
  });
});

describe("chemin VIDÉO — livraison durable + carte dans le fil", () => {
  it("runVideoTurn : le message de LANCEMENT porte videoProjectId (carte immédiate)", () => {
    const source = lire("lib/domain/conversations/engine-media.ts");
    expect(source).toContain("videoProjectId: job.projectId,\n      generationStatus: \"complete\"");
  });

  it("production-delivery : master média propriétaire → URL durable (jamais 900 s)", () => {
    const source = lire("lib/video/production-delivery.ts");
    expect(source).toContain("r2Key.startsWith(`users/${job.userId}/permanent/`)");
    expect(source).toContain("r2Key.startsWith(`users/${job.userId}/video/`)");
    expect(source).toContain("urlDurableAbsolue(r2Key, job.origineClient)");
    expect(source).toContain("videoProjectId: job.projectId");
  });
});

describe("UI chat — le média apparaît VRAIMENT dans la conversation", () => {
  it("nova-chat rend un lecteur <audio> durable dans la bulle", () => {
    const source = lire("components/chat/nova-chat.tsx");
    expect(source).toContain("m.audioUrl");
    expect(source).toContain("<audio");
    expect(source).toContain("controls preload=\"metadata\"");
  });

  it("nova-chat rend la carte vidéo dans le fil", () => {
    const source = lire("components/chat/nova-chat.tsx");
    expect(source).toContain("<CarteVideoFil");
    expect(source).toContain("m.videoProjectId");
  });

  it("artifact_created n'est plus ignoré : audio → lecteur, vidéo → carte", () => {
    const source = lire("components/chat/nova-chat.tsx");
    expect(source).toContain("case \"artifact_created\":");
    expect(source).toContain("/api/media/durable?path=");
    expect(source).toContain("ar.videoProjectId");
  });

  it("message_complete + done propagent les champs durables au fil", () => {
    const source = lire("components/chat/nova-chat.tsx");
    expect(source).toContain("event.message.audioUrl");
    expect(source).toContain("event.message.videoProjectId");
    expect(source).toContain("final.audioUrl");
    expect(source).toContain("final.videoProjectId");
  });

  it("la carte vidéo résout une URL de lecture FRAÎCHE via /render (jamais présignée figée)", () => {
    const source = lire("components/chat/carte-video-fil.tsx");
    expect(source).toContain("/api/video/projects/${videoProjectId}/render");
    expect(source).toContain("playbackUrl");
    expect(source).toContain("<video");
    expect(source).toContain("/api/video/projects/${videoProjectId}/production/stream");
  });

  it("la carte affiche l'échec réel de production (jamais de succès inventé)", () => {
    const source = lire("components/chat/carte-video-fil.tsx");
    expect(source).toContain("type: \"echec\"");
    expect(source).toContain("Production interrompue");
  });

  // FIX 2026-11-13 (« la barre de progression n'augmente pas ») : le
  // serveur stocke la progression en 0..1 (contrat UI ×100) — la carte du
  // fil appliquait Math.round() NU : la barre restait à 0 % pendant toute
  // la production. Verrou : conversion tolérante + monotone + état conservé.
  it("la barre du fil convertit le contrat 0..1 en POURCENTAGE (×100) — barre qui AUGMENTE", () => {
    const source = lire("components/chat/carte-video-fil.tsx");
    // Conversion tolérante identique à la carte workspace (0..1 → %).
    expect(source).toContain("function pourcentageDepuis");
    expect(source).toContain("valeur <= 1 ? valeur * 100 : valeur");
    expect(source).toContain("Math.max(0, Math.min(100");
    // La valeur affichée dans le fil est le pourcentage converti —
    // plus JAMAIS un Math.round() nu sur la valeur 0..1 brute.
    expect(source).not.toContain("Math.round(etat.progress)");
    expect(source).toContain("const progression = etat.type === \"progression\" ? etat.progress : 0");
  });

  it("la progression du fil est MONOTONE et l'état est CONSERVÉ sous incident (503/réseau)", () => {
    const source = lire("components/chat/carte-video-fil.tsx");
    // Plafond monotone : une lecture plus basse ne fait jamais reculer.
    expect(source).toContain("plafond");
    expect(source).toContain("pct > plafond.current");
    // Incident du canal de statut : dernier état connu conservé (pas de
    // repli vers « préparation 0 % ») — la requête renvoyée non-OK ou
    // rejetée laisse l'état courant inchangé.
    expect(source).not.toContain('.catch(() => ({}))');
    expect(source).toContain("if (!st || typeof st !== \"object\") return;");
  });

  // FIX 2026-11-13 (« chaque requête vidéo échoue ») : la création du
  // document job (seul point de non-retour du lancement) est retentée
  // sous incident passager du stockage — un stall ne transforme plus une
  // demande vidéo valide en échec affiché dans le fil.
  it("le lancement du job retente la création sous incident (stall/disjoncteur) — already_exists = succès", () => {
    const source = lire("lib/video/production-queue.ts");
    expect(source).toContain("ROBUSTESSE LANCEMENT");
    expect(source).toContain("code === \"already_exists\"");
    // Trois tentatives espacées, jamais un échec immédiat au premier stall.
    expect(source).toContain("tentative === 1 ? 3_000 : 8_000");
  });

  it("l'échec de lancement distingue la saturation momentanée (message honnête et actionnable)", () => {
    const source = lire("lib/domain/conversations/engine-media.ts");
    expect(source).toContain("saturation MOMENTANÉE du stockage");
    expect(source).toContain("protection anti-tempête");
  });

  it("le TOUR vidéo relance le lancement complet sous incident passager (classifyTickError ≠ fatal)", () => {
    const source = lire("lib/domain/conversations/engine-media.ts");
    expect(source).toContain("ROBUSTESSE LANCEMENT");
    expect(source).toContain("classifyTickError");
    // Relances espacées — un stall ne tue plus la demande immédiatement.
    expect(source).toContain("tentative === 0 ? 5_000 : 12_000");
    // Les échecs FATAUX (validation, limite) restent immédiats.
    expect(source).toContain('classifyTickError(erreurLancement) !== "fatal"');
  });
});

describe("honnêteté & sécurité de la livraison durable", () => {
  it("aucune URL d'appelant n'est acceptée par la route (anti-falsification)", () => {
    const source = lire("app/api/media/durable/route.ts");
    // La clé vient du paramètre path validé contre l'UID de session —
    // jamais d'URL complète, jamais un autre préfixe.
    expect(source).not.toContain("request.nextUrl.origin");
    expect(source).not.toContain("https://");
  });

  it("aucun secret en clair dans les fichiers de livraison", () => {
    const fichiers = [
      "lib/media/url-durable.ts",
      "app/api/media/durable/route.ts",
      "lib/domain/conversations/engine-media.ts",
      "lib/video/production-delivery.ts",
      "components/chat/carte-video-fil.tsx",
    ];
    for (const f of fichiers) {
      const source = lire(f);
      expect(source).not.toMatch(/hf_[A-Za-z0-9]{20,}/);
      expect(source).not.toMatch(/KGAT_[A-Za-z0-9]{10,}/);
      expect(source).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
      expect(source).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
    }
  });
});
