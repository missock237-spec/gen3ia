/**
 * Lecteur NDJSON « Live Voix » (Task 110-b) — module PUR.
 *
 * Transforme un ReadableStream binaire (réponse HTTP de POST
 * /api/live/voice/turn, Content-Type application/x-ndjson) en un
 * AsyncGenerator d'objets JSON typés.
 *
 * Robustesse :
 *  - les chunks réseau coupent les lignes n'importe où : un buffer interne
 *    réassemble les lignes partielles (séparateur "\n", "\r" final toléré) ;
 *  - les lignes vides sont ignorées (keep-alive éventuel d'un proxy) ;
 *  - une ligne JSON malformée est ignorée (elle ne doit pas tuer le flux) ;
 *  - une dernière ligne sans "\n" final est tout de même consommée ;
 *  - la fermeture anticipée (break du consommateur, ex. barge-in fatal)
 *    libère le verrou du reader proprement.
 */

/**
 * Parcourt le flux et yield chaque objet JSON complet.
 *
 * @param reader reader du corps de réponse (response.body.getReader())
 * @yields un objet JSON par ligne NDJSON complète
 */
export async function* parseNdjsonStream<T = unknown>(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<T, void, undefined> {
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Consomme toutes les lignes COMPLÈTES du buffer ; le reste attend
      // le chunk suivant (les lignes partielles ne sont jamais émises).
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          try {
            yield JSON.parse(line) as T;
          } catch {
            /* ligne JSON malformée : ignorée (le flux continue) */
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }

    // Fin du flux : traite une éventuelle dernière ligne sans "\n" final.
    buffer += decoder.decode();
    const rest = buffer.trim();
    if (rest) {
      try {
        yield JSON.parse(rest) as T;
      } catch {
        /* dernière ligne malformée : ignorée */
      }
    }
  } finally {
    // Libère le verrou pour que l'appelant puisse cancel() le flux s'il a
    // interrompu la lecture (erreur fatale, barge-in, arrêt utilisateur).
    try {
      reader.releaseLock();
    } catch {
      /* reader déjà libéré ou stream en erreur */
    }
  }
}
