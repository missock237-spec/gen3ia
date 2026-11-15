/**
 * WAV PUR — décodage, fondu et concaténation PCM (aucune dépendance,
 * aucun I/O) : partagé par la FUSION CENTRALE de l'essaim (server) et le
 * MOTEUR VOIX local (navigateur) — la même mathématique des deux côtés.
 */

interface PcmDécodé {
  taux: number;
  canaux: number;
  /** Échantillons entrelacés normalisés [-1, 1]. */
  échantillons: Float32Array;
}

/** Lit l'en-tête RIFF et décode PCM int16 ou float32 en Float32 (pur). */
function décoderWav(buf: Uint8Array): PcmDécodé {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const lire4 = (o: number): string =>
    String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (buf.length < 44 || lire4(0) !== "RIFF" || lire4(8) !== "WAVE") {
    throw new Error("WAV invalide (en-tête RIFF/WAVE absent).");
  }
  let offset = 12;
  let format = 0;
  let canaux = 1;
  let taux = 24000;
  let bits = 0;
  let données: { o: number; taille: number } | null = null;
  while (offset + 8 <= buf.length) {
    const id = lire4(offset);
    const taille = dv.getUint32(offset + 4, true);
    if (id === "fmt ") {
      format = dv.getUint16(offset + 8, true);
      canaux = dv.getUint16(offset + 10, true);
      taux = dv.getUint32(offset + 12, true);
      bits = dv.getUint16(offset + 22, true);
    } else if (id === "data") {
      données = { o: offset + 8, taille: Math.min(taille, buf.length - offset - 8) };
    }
    offset += 8 + taille + (taille % 2);
  }
  if (!données) throw new Error("WAV invalide (chunk data absent).");
  const { o, taille } = données;
  let échantillons: Float32Array;
  if (format === 3 && bits === 32) {
    const n = Math.floor(taille / 4);
    échantillons = new Float32Array(n);
    for (let i = 0; i < n; i++) échantillons[i] = dv.getFloat32(o + i * 4, true);
  } else if (format === 1 && bits === 16) {
    const n = Math.floor(taille / 2);
    échantillons = new Float32Array(n);
    for (let i = 0; i < n; i++) échantillons[i] = dv.getInt16(o + i * 2, true) / 32768;
  } else {
    throw new Error(`WAV non pris en charge (format ${format}, ${bits} bits).`);
  }
  return { taux, canaux, échantillons };
}

/** Encode Float32 entrelacé → WAV PCM int16 (pur, en-tête canonique 44 octets). */
function encoderWav(échantillons: Float32Array, taux: number, canaux: number): Uint8Array {
  const n = échantillons.length;
  const out = new Uint8Array(44 + n * 2);
  const dv = new DataView(out.buffer);
  const écrire4 = (o: number, s: string): void => {
    for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i);
  };
  écrire4(0, "RIFF");
  dv.setUint32(4, 36 + n * 2, true);
  écrire4(8, "WAVE");
  écrire4(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, canaux, true);
  dv.setUint32(24, taux, true);
  dv.setUint32(28, (taux * canaux * 2) | 0, true); // byte rate
  dv.setUint16(32, canaux * 2, true); // bloc align
  dv.setUint16(34, 16, true);
  écrire4(36, "data");
  dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const v = Math.min(1, Math.max(-1, échantillons[i]));
    dv.setInt16(44 + i * 2, Math.round(v * 32767), true);
  }
  return out;
}

/** Mixe deux trains mono en fondu d'égalité de puissance (pur). */
function fondre(a: Float32Array, b: Float32Array, nbFondu: number): Float32Array {
  const total = a.length + b.length - nbFondu;
  const out = new Float32Array(total);
  for (let i = 0; i < a.length; i++) out[i] = a[i];
  for (let i = 0; i < nbFondu; i++) {
    const t = i / nbFondu;
    const ga = Math.cos((t * Math.PI) / 2);
    const gb = Math.sin((t * Math.PI) / 2);
    out[a.length - nbFondu + i] = a[a.length - nbFondu + i] * ga + b[i] * gb;
  }
  for (let i = nbFondu; i < b.length; i++) {
    out[a.length - nbFondu + i] = b[i];
  }
  return out;
}

/**
 * Concatène N WAV (même format) avec un micro-fondu d'égalité de
 * puissance (60 ms par défaut) : la voix reste CONTINUE, sans clic.
 * Pur — testé.
 */
export function concaténerWav(buffers: Uint8Array[], fonduMs = 60): Uint8Array {
  if (buffers.length === 0) throw new Error("Aucun segment de voix à fusionner.");
  if (buffers.length === 1) return buffers[0];
  const décodés = buffers.map(décoderWav);
  const [premier] = décodés;
  for (const d of décodés) {
    if (d.taux !== premier.taux || d.canaux !== premier.canaux) {
      throw new Error("Segments de voix de formats hétérogènes — fusion refusée.");
    }
  }
  const trains = décodés.map((d) => {
    if (d.canaux === 1) return d.échantillons;
    const n = Math.floor(d.échantillons.length / d.canaux);
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let c = 0; c < d.canaux; c++) s += d.échantillons[i * d.canaux + c];
      mono[i] = s / d.canaux;
    }
    return mono;
  });
  const nbFondu = Math.min(Math.round((fonduMs / 1000) * premier.taux), trains[0].length);
  let accumulé = trains[0];
  for (let i = 1; i < trains.length; i++) {
    accumulé = fondre(accumulé, trains[i], nbFondu);
  }
  return encoderWav(accumulé, premier.taux, 1);
}
