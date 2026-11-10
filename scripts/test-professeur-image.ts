/* TEST RÉEL du professeur image — appel gateway /images/generations.
 * Sauvegarde le rendu sur disque pour inspection visuelle. */
import { writeFileSync } from "node:fs";
import { professeurDisponible, professeurImage } from "../lib/neural/professeur-media";

async function main(): Promise<void> {
  const dispo = professeurDisponible();
  console.log("professeurDisponible:", dispo);
  if (!dispo) {
    console.log("ABSENT — pas de config");
    process.exit(2);
  }
  const t0 = Date.now();
  try {
    const œuvre = await professeurImage({
      prompt: "un homme assis sur une branche d'arbre dans une forêt de lumière, ultra réaliste",
      ratio: "3:2",
    });
    console.log("OK en", Date.now() - t0, "ms — octets:", œuvre.buffer.length, "mime:", œuvre.mime);
    console.log("meta:", JSON.stringify(œuvre.meta));
    writeFileSync("/tmp/professeur-image-test.jpg", œuvre.buffer);
    console.log("écrit: /tmp/professeur-image-test.jpg");
  } catch (e) {
    console.log("ÉCHEC en", Date.now() - t0, "ms:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
main();
