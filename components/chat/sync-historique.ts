/* ================= SYNCHRONISATION SERVEUR DE L'HISTORIQUE =================
 * Repositionnement style Gemini — suite (2026-11-06, Job 478451).
 *
 * Problème : la sidebar « Récents » ne lisait que le cache localStorage
 * (scopé par uid, 60 conversations) — l'historique créé sur un autre
 * appareil était invisible, sauf par la recherche globale. Gemini, lui,
 * suit l'utilisateur partout.
 *
 * Ce module contient la logique PURE de la synchronisation :
 *  1. `fusionnerHistoriqueServeur` — fusionne la liste serveur (méta :
 *     id/titre/updatedAt) avec le cache local SANS jamais écraser une
 *     conversation locale : les conversations serveur absentes du cache
 *     deviennent des « stubs » (méta seule, messages vides) hydratés à la
 *     sélection ; les conversations locales sans serverId (créées hors
 *     ligne) sont conservées telles quelles.
 *  2. `messagesDepuisServeur` — mapping fidèle détail serveur → messages
 *     locaux (même mécanique que l'import par recherche globale).
 *
 * Confidentialité : la fusion n'est appelée QUE pour un utilisateur
 * résolu (uid non nul) — jamais dans le compartiment « invite ».
 * Le serveur reste l'AUTORITÉ pour le titre et la date de mise à jour ;
 * le cache local reste la vérité affichée en cas d'échec réseau. */

/** Méta d'une conversation telle que renvoyée par
 * GET /api/workspace/conversations (dépôt lib/chat/repository.ts). */
export interface ConversationServeurMeta {
  id?: string;
  title?: string;
  updatedAt?: string;
  messageCount?: number;
}

/** Forme minimale requise d'une conversation locale (NovaConversation
 * la satisfait structurellement — pas d'import circulaire). */
export interface ConversationLocaleMinimale {
  id: string;
  serverId?: string;
  titre: string;
  maj: number;
  messages: unknown[];
}

/** Message local minimal (NovaMessage le satisfait structurellement). */
export interface MessageLocalMinimal {
  id: string;
  serverId?: string;
  role: "user" | "assistant";
  content: string;
  date: number;
  modele?: string;
  /** LIVRAISON MÉDIA DURABLE (2026-11-12) : audio jouable à vie dans le
   *  fil (URL canonique re-signée) — jamais une présignée expirable. */
  audioUrl?: string;
  /** Projet vidéo du tour : carte progression/lecteur du fil (URL fraîche
   *  résolue par la carte via GET /render). */
  videoProjectId?: string;
}

/** Détail serveur renvoyé par GET /api/workspace/conversations/[id]. */
export interface DetailConversationServeur {
  conversation?: ConversationServeurMeta;
  messages?: Array<{
    id?: string;
    role?: string;
    content?: string;
    createdAt?: string;
    model?: string;
    audioUrl?: string;
    videoProjectId?: string;
  }>;
}

/** Fusionne la liste serveur dans le cache local (PUR — testé directement).
 *
 * Règles :
 *  - une conversation serveur déjà connue localement (même `serverId`) est
 *    MISE À JOUR : le titre serveur gagne s'il est non vide, `maj` prend le
 *    max(local, serveur) — jamais de régression de date ;
 *  - une conversation serveur inconnue devient un STUB (méta seule,
 *    messages vides) — son contenu sera hydraté à la sélection ;
 *  - les conversations locales sans `serverId` (hors ligne, non encore
 *    synchronisées) sont toujours conservées ;
 *  - résultat trié par `maj` décroissante et plafonné à `maxConvs`.
 *
 * @param locales      état courant du cache (non muté)
 * @param serveurs     méta serveur (ordre quelconque)
 * @param creerId      fabrique d'identifiants locaux (idSuivant injecté)
 * @param maintenant   horodatage de référence (determinisme des tests)
 * @param maxConvs     plafond du cache local
 * @returns la nouvelle liste + compteurs (nouvelles conversations importées,
 *          titres/dates actualisés) — l'UI ne re-rend que si nécessaire.
 */
export function fusionnerHistoriqueServeur<
  C extends ConversationLocaleMinimale,
>(
  locales: readonly C[],
  serveurs: readonly ConversationServeurMeta[],
  creerId: () => string,
  maintenant: number,
  maxConvs: number,
): { convs: C[]; nouvelles: number; misesAJour: number } {
  let nouvelles = 0;
  let misesAJour = 0;
  const parServerId = new Map<string, C>();
  for (const conv of locales) {
    if (conv.serverId) parServerId.set(conv.serverId, conv);
  }
  const resultat: C[] = [];

  for (const srv of serveurs) {
    if (!srv || typeof srv.id !== "string" || srv.id.length === 0) continue;
    const locale = parServerId.get(srv.id);
    const titreServeur = typeof srv.title === "string" && srv.title.trim().length > 0 ? srv.title : null;
    if (locale) {
      // Déjà connue : actualisation douce (serveur autorité titre/date).
      const majServeur = Date.parse(srv.updatedAt ?? "") || 0;
      const majFusion = Math.max(locale.maj, majServeur);
      const titre = titreServeur ?? locale.titre;
      if (titre !== locale.titre || majFusion !== locale.maj) misesAJour += 1;
      resultat.push({ ...locale, titre, maj: majFusion });
      parServerId.delete(srv.id); // consommée — ne pas la dupliquer ensuite
    } else {
      // Inconnue du cache : stub multi-appareils (hydraté à la sélection).
      nouvelles += 1;
      resultat.push({
        id: creerId(),
        serverId: srv.id,
        titre: titreServeur ?? "Conversation",
        maj: Date.parse(srv.updatedAt ?? "") || maintenant,
        messages: [],
      } as unknown as C);
    }
  }

  // Conversations locales restantes : celles présentes sur le serveur
  // au-delà de la fenêtre de listage (serverId encore dans la map) puis les
  // locales pures (sans serverId — créées hors ligne, à synchroniser plus tard).
  for (const restante of parServerId.values()) resultat.push(restante);
  for (const locale of locales) {
    if (!locale.serverId) resultat.push(locale);
  }

  resultat.sort((a, b) => b.maj - a.maj);
  return { convs: resultat.slice(0, Math.max(1, maxConvs)), nouvelles, misesAJour };
}

/** Mappe le détail serveur (conversation + messages) vers les messages
 *  locaux — EXTRAIT de la logique d'import par recherche globale
 *  (ouvrirResultatRecherche) pour la partager avec l'hydratation des stubs.
 *  Fidélité : rôle binaire user/assistant, date parsée sinon maintenant,
 *  `serverId` porté sauf préfixe local synthétique « srv- ». */
export function messagesDepuisServeur(
  detail: DetailConversationServeur,
  maintenant: number,
  creerId: () => string,
): MessageLocalMinimal[] {
  return (detail.messages ?? []).map((m, index) => ({
    id: m.id ?? `srv-${index}-${creerId()}`,
    serverId: typeof m.id === "string" && !m.id.startsWith("srv-") ? m.id : undefined,
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content ?? ""),
    date: Date.parse(m.createdAt ?? "") || maintenant,
    modele: m.model,
    // LIVRAISON MÉDIA DURABLE : lecteur audio + carte vidéo restent jouables
    // après rechargement/rattrapage (les champs sont persistés serveur).
    ...(typeof m.audioUrl === "string" && m.audioUrl.length > 0 ? { audioUrl: m.audioUrl } : {}),
    ...(typeof m.videoProjectId === "string" && m.videoProjectId.length > 0 ? { videoProjectId: m.videoProjectId } : {}),
  }));
}

/**
 * Résout l'UID depuis le corps de GET /api/auth/session — DEUX formes
 * observées en production (sonde vidéo 2026-11-12) :
 *   - `{ authenticated: true, uid: "r2_…" }` (forme historique attendue) ;
 *   - `{ authenticated: true, user: { uid: "r2_…" } }` (forme RÉELLE de
 *     l'API r2 — le code lisait `corps.uid` au niveau racine et resolvait
 *     donc JAMAIS l'identité : le chat se croyait invité en session valide
 *     — cache par utilisateur jamais écrit, fusion d'historique jamais
 *     déclenchée, rattrapage des livraisons jamais exécuté, bouton
 *     « Se connecter » affiché malgré l'authentification).
 * Retourne null si non authentifié ou UID absent — jamais d'invention.
 */
export function resoudreUidSession(
  corps: unknown,
): string | null {
  if (typeof corps !== "object" || corps === null) return null;
  const c = corps as { authenticated?: unknown; uid?: unknown; user?: { uid?: unknown } };
  if (c.authenticated !== true) return null;
  if (typeof c.uid === "string" && c.uid.length > 0) return c.uid;
  if (typeof c.user?.uid === "string" && c.user.uid.length > 0) return c.user.uid;
  return null;
}
