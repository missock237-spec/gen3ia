/**
 * Filtrage des balises de raisonnement interne (« think », « thinking »,
 * « reasoning ») qui fuient dans les réponses de certains modèles
 * (GLM-4-Flash, DeepSeek-R1, Qwen…).
 *
 * Deux mécanismes complémentaires :
 *  - `stripThinkTags(text)` : nettoyage d'un texte complet avant persistance
 *    ou rendu final ;
 *  - `ThinkTagStreamFilter` : machine à états incrémentale qui filtre les
 *    deltas d'un flux en temps réel, y compris les balises coupées entre
 *    deux chunks — l'utilisateur ne doit JAMAIS voir apparaître une balise.
 *
 * Module pur (aucune dépendance) : testable en vitest, utilisable côté
 * serveur comme côté client.
 */

/** Balises d'ouverture dont le contenu doit être masqué à l'utilisateur. */
const OPEN_TAGS = ["<think>", "<thinking>", "<reasoning>"] as const;

/** Balises de fermeture correspondantes (même ordre que OPEN_TAGS). */
const CLOSE_TAGS = ["</think>", "</thinking>", "</reasoning>"] as const;

/** Longueur maximale d'un buffer de piste (balise la plus longue + marge). */
const MAX_TAG_LEN = Math.max(...OPEN_TAGS.map((t) => t.length), ...CLOSE_TAGS.map((t) => t.length));

/** États de la machine à filtrage incrémental. */
const enum ThinkStreamState {
  /** Texte normal : on émet. */
  Normal = 0,
  /** Buffer en cours qui POURRAIT être une balise d'ouverture (« <thi »). */
  MaybeOpen = 1,
  /** Dans un bloc de raisonnement : on supprime jusqu'à la fermeture. */
  InThink = 2,
}

/**
 * Supprime toutes les balises de raisonnement d'un texte complet.
 * - blocs fermés : `<think>…</think>` (non glouton, multi-lignes) ;
 * - bloc non fermé en fin de texte : tout le résidu est supprimé ;
 * - espaces superflus laissés par la suppression : neutralisés en début
 *   et fin de chaîne, le corps garde sa mise en forme.
 */
export function stripThinkTags(text: string): string {
  if (!text) return text;
  let out = text;
  for (let i = 0; i < OPEN_TAGS.length; i += 1) {
    out = out
      .replace(new RegExp(`${OPEN_TAGS[i]}[\\s\\S]*?${CLOSE_TAGS[i]}`, "gi"), "")
      .replace(new RegExp(`${OPEN_TAGS[i]}[\\s\\S]*$`, "gi"), "");
  }
  return out.replace(/^\s+(?=\S)/, "").replace(/\s+$/, "");
}

/**
 * Filtre incrémental de flux : `push()` renvoie la portion émettable du
 * delta ("" si rien), `end()` termine le filtre (le résidu d'un bloc non
 * fermé est supprimé ; le texte normal résiduel est émis).
 */
export class ThinkTagStreamFilter {
  private state: ThinkStreamState = ThinkStreamState.Normal;
  private buffer = "";

  push(delta: string): string {
    if (!delta) return "";
    let pending = delta;
    let emitted = "";

    // Reprendre la piste de fermeture conservée du push précédent.
    if (this.state === ThinkStreamState.InThink && this.buffer) {
      pending = this.buffer + pending;
      this.buffer = "";
    }

    while (pending.length > 0) {
      if (this.state === ThinkStreamState.Normal) {
        const lt = pending.indexOf("<");
        if (lt === -1) {
          emitted += pending;
          pending = "";
          break;
        }
        emitted += pending.slice(0, lt);
        pending = pending.slice(lt);
        this.state = ThinkStreamState.MaybeOpen;
        this.buffer = "";
        continue;
      }

      if (this.state === ThinkStreamState.MaybeOpen) {
        // Accumuler la piste (jusqu'à dépasser la longueur maximale d'une
        // balise — au-delà, c'est forcément du texte normal).
        const room = MAX_TAG_LEN - this.buffer.length;
        if (room > 0) {
          this.buffer += pending.slice(0, room);
          pending = pending.slice(room);
        }
        const lower = this.buffer.toLowerCase();
        const openIdx = OPEN_TAGS.findIndex((tag) => lower.startsWith(tag));
        if (openIdx !== -1) {
          // Balise d'ouverture confirmée : le reste du buffer est du
          // raisonnement à supprimer — le traiter comme tel.
          const rest = this.buffer.slice(OPEN_TAGS[openIdx].length);
          this.state = ThinkStreamState.InThink;
          this.buffer = "";
          pending = rest + pending;
          continue;
        }
        if (OPEN_TAGS.some((tag) => tag.startsWith(lower))) {
          continue; // préfixe strict : attendre la suite du flux
        }
        // Fausse piste : émettre le buffer SAUF un éventuel nouveau « < »
        // qui redémarre une piste (ex. « 1 < 2 <thi »).
        const nextLt = lower.indexOf("<", 1);
        if (nextLt === -1) {
          emitted += this.buffer;
          this.buffer = "";
          this.state = ThinkStreamState.Normal;
          continue;
        }
        emitted += this.buffer.slice(0, nextLt);
        pending = this.buffer.slice(nextLt) + pending;
        this.buffer = "";
        this.state = ThinkStreamState.Normal;
        continue;
      }

      // InThink : supprimer jusqu'à la balise de fermeture.
      const lower = pending.toLowerCase();
      const closeIdx = CLOSE_TAGS.map((tag) => lower.indexOf(tag))
        .filter((i) => i !== -1)
        .sort((a, b) => a - b)[0];
      if (closeIdx !== undefined) {
        const matched = CLOSE_TAGS.find((tag) => lower.startsWith(tag, closeIdx)) as string;
        pending = pending.slice(closeIdx + matched.length);
        this.state = ThinkStreamState.Normal;
        this.buffer = "";
        continue;
      }
      // Pas de fermeture complète : ne garder que le suffixe qui pourrait
      // en être le préfixe (ex. « </thin »), supprimer le reste — la piste
      // est conservée pour le prochain push.
      const keep = this.longestClosePrefix(pending);
      this.buffer = keep > 0 ? pending.slice(pending.length - keep) : "";
      pending = "";
      if (keep > 0) break;
    }
    return emitted;
  }

  end(): string {
    // Fin de flux : une piste « <thi » non résolue est presque toujours une
    // balise tronquée — on ne l'émet pas. Texte normal résiduel : émis.
    const rest = this.state === ThinkStreamState.Normal ? this.buffer : "";
    this.buffer = "";
    this.state = ThinkStreamState.Normal;
    return rest;
  }

  /** Longueur du plus long suffixe de `s` préfixant une balise de fermeture. */
  private longestClosePrefix(s: string): number {
    for (let len = Math.min(s.length, MAX_TAG_LEN); len > 0; len -= 1) {
      const suffix = s.slice(s.length - len).toLowerCase();
      if (CLOSE_TAGS.some((tag) => tag.startsWith(suffix))) return len;
    }
    return 0;
  }
}
