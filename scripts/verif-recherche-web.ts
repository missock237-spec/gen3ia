/* Vérification réseau réelle du moteur de recherche web gen3ia. */
import { rechercheWebTempsReel } from "../lib/recherche-web/moteurs/../index";

async function main() {
  const reponse = await rechercheWebTempsReel("dernières actualités intelligence artificielle", {
    maxResults: 6,
    lirePages: false,
  });
  console.log("=== DIAGNOSTIC ===");
  console.log(JSON.stringify(reponse.diagnostic, null, 2));
  console.log("=== TOP 6 ===");
  reponse.resultats.forEach((r, i) =>
    console.log(
      `[${i + 1}] ${r.titre}\n    ${r.url}\n    moteur=${r.moteur} confirmations=${r.confirmations} crédibilité=${r.credibilite}`,
    ),
  );

  const avecPages = await rechercheWebTempsReel("Next.js 15 release notes", {
    maxResults: 4,
    lirePages: true,
  });
  console.log("=== PAGES LUES ===");
  avecPages.pages?.forEach((p) =>
    console.log(`- ${p.titre} (méthode=${p.methode}, ${p.texte.length} chars extraits, date=${p.datePublication ?? "n/a"})`),
  );
}

main().catch((e) => {
  console.error("ÉCHEC :", e);
  process.exit(1);
});
