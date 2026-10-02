/**
 * Parser SSE (Server-Sent Events) minimal et borné, dédié au flux de
 * progression des missions (/api/agents/runs/:runId/stream).
 *
 * Le serveur émet :
 *   event: progress\ndata: {...}\n\n     — à chaque changement significatif
 *   event: final\ndata: {...}\n\n        — quand la mission est terminée
 *   : ping\n\n                          — heartbeat (commentaire SSE)
 *
 * Implémentation : machine à états ligne par ligne (découpe \n, tolère \r\n),
 * tampon borné à 1 Mio — un flux défaillant qui ne terminerait jamais ses
 * lignes est coupé (Gen3iaError) au lieu de croître sans limite en mémoire.
 */

import { Gen3iaError } from "./errors.js";

export interface SseEvent {
  /** Nom d'événement — « message » par défaut (convention SSE). */
  event: string;
  /** Données multi-lignes jointes par \n, non parsées (le client décide). */
  data: string;
}

export interface SseParser {
  /** Ingeste un fragment texte (peut couper une ligne en deux). */
  push(chunk: string): void;
  /** Termine le flux — vide une dernière ligne complète restante. */
  end(): void;
}

/** Au-delà, on considère le flux corrompu : 1 Mio couvre très largement le contrat. */
const MAX_BUFFER_CHARS = 1_048_576;

export function createSseParser(onEvent: (event: SseEvent) => void): SseParser {
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];

  const dispatch = () => {
    const data = dataLines.join("\n");
    if (data === "") {
      // Spec SSE : un événement sans buffer de données n'est PAS distribué
      // (« event: » seul, ou « data: » vide) — tampons réinitialisés.
      eventName = "";
      dataLines = [];
      return;
    }
    onEvent({ event: eventName || "message", data });
    eventName = "";
    dataLines = [];
  };

  const consumeLine = (line: string) => {
    // Commentaire SSE (heartbeat du serveur) ou ligne vide de fin d'événement.
    if (line.startsWith(":")) return;
    if (line === "") {
      dispatch();
      return;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    // La spec SSE n'autorise QU'UN SEUL espace optionnel après le deux-points.
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
    // Les autres champs (id:, retry:) n'existent pas dans ce contrat — ignorés.
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      if (buffer.length > MAX_BUFFER_CHARS) {
        // Le tampon ne contient AUCUN \n : rejet défensif (pas de croissance).
        throw new Gen3iaError("Flux SSE corrompu : ligne dépassant 1 Mio sans fin d'événement.");
      }
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        consumeLine(line);
      }
    },
    end() {
      // Une dernière ligne sans \n final reste un événement valide (spec SSE :
      // le flux interrompu distribue la ligne partielle en attente).
      const last = buffer;
      buffer = "";
      if (last !== "") consumeLine(last.endsWith("\r") ? last.slice(0, -1) : last);
      dispatch();
    },
  };
}
