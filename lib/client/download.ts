"use client";

/**
 * Téléchargement client robuste : l'URL est d'abord récupérée en Blob
 * (le navigateur force alors l'enregistrement, même pour des URLs signées
 * servies inline), avec repli sur l'ouverture dans un onglet quand la
 * politique CORS du serveur distant bloque la lecture.
 */
export async function downloadUrl(url: string, filename: string): Promise<void> {
  try {
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
  } catch {
    // CORS ou réseau : on tente le téléchargement natif (attribut download
    // honoré pour les URLs same-origin ; sinon ouverture classique).
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.target = "_blank";
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }
}

/** Télécharge un data URI (ex. audio généré) via Blob — toujours autorisé. */
export function downloadDataUri(dataUri: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = dataUri;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
