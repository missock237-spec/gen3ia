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
  it("runVoixTurn : urlDurableAbsolue dans le contenu + audioUrl persisté", () => {
    const source = lire("lib/domain/conversations/engine-media.ts");
    expect(source).toContain("urlDurableAbsolue(rendu.cleStockage)");
    expect(source).toContain("urlDurableRelative(rendu.cleStockage)");
    expect(source).toContain("audioUrl: audioUrlDurable");
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
    expect(source).toContain("urlDurableAbsolue(r2Key)");
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
