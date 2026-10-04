// Déclarations globales TypeScript pour Gen3ia.
//
// `*.css` (import side-effect dans app/layout.tsx) : Next 15 ne fournit
// aucune déclaration pour les imports CSS simples (ajoutée en Next 16) et
// TypeScript 5.9+ vérifie désormais les imports side-effect (TS2882).
// Les *.module.css typés sont déjà déclarés par next/types/global.d.ts.
declare module "*.css";

// ffprobe-static (Task 1-a — résolution binaire FFmpeg) : le paquet ne
// fournit aucune déclaration TypeScript ; il exporte CommonJS `{ path: string }`.
declare module "ffprobe-static" {
  const ffprobeStatic: { path: string };
  export default ffprobeStatic;
}

// ffmpeg-static (Task 1-a) : CommonJS `module.exports = <chemin du binaire>`
// (null si le script d'installation n'a pas tourné).
declare module "ffmpeg-static" {
  const ffmpegStatic: string | null;
  export default ffmpegStatic;
}
