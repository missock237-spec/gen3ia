/**
 * Encodeur WAV « Live Voix » (Task 110-b) — module PUR.
 *
 * Concatène des trames PCM 16 bits et produit un Blob WAV mono complet
 * (entête RIFF/Wave canonique de 44 octets + données little-endian), prêt
 * pour POST /api/live/voice/turn (champ `audio`, mime audio/wav).
 *
 * Aucune dépendance : `Blob` est disponible dans les navigateurs ET dans
 * Node ≥ 18 (tests vitest en environnement node).
 */

/** Longueur canonique de l'entête RIFF/Wave PCM : 44 octets. */
export const WAV_HEADER_BYTES = 44;

/** Écrit une chaîne ASCII dans un DataView (champs "RIFF", "WAVE", "fmt ", "data"). */
function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i) & 0xff);
  }
}

/**
 * Encode des trames PCM 16 bits en un fichier WAV mono.
 *
 * @param chunks     trames dans l'ordre chronologique (peut être vide)
 * @param sampleRate fréquence d'échantillonnage (défaut 16 000 Hz, cible worklet)
 */
export function encodeWav(chunks: Int16Array[], sampleRate = 16_000): Blob {
  const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const dataBytes = totalSamples * 2; // PCM16 = 2 octets par échantillon

  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  // Bloc descripteur RIFF.
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true); // taille du fichier - 8
  writeAscii(view, 8, "WAVE");

  // Bloc fmt : PCM (1), 1 canal, fréquence, alignements 16 bits.
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // taille du sous-bloc fmt
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byteRate = sampleRate × blockAlign
  view.setUint16(32, 2, true); // blockAlign = canaux × octets/échantillon
  view.setUint16(34, 16, true); // bits par échantillon

  // Bloc data.
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  // Données : concaténation little-endian des trames.
  let offset = WAV_HEADER_BYTES;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      view.setInt16(offset, chunk[i], true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: "audio/wav" });
}
