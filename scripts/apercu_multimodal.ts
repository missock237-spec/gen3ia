/** Aperçus PNG des moteurs multimodaux v2 (contrôle visuel ponctuel). */
import { mkdirSync, writeFileSync } from "node:fs";

import { capturerSnapshot } from "../lib/neural/generation/snapshot";
import { ReseauNeuronalGen3 } from "../lib/neural/core/network";
import { analyserScene, analyserScenesMultiples, construireLexique } from "../lib/neural/generation/scene-spec";
import { genererVisuelScene } from "../lib/neural/generation/visual-scene";
import { genererVideoScene } from "../lib/neural/generation/video-storyboard";
import { entrainerLexiqueMultimodal } from "../lib/neural/generation/entrainement-lexique";

const reseau = new ReseauNeuronalGen3({ nbNeurones: 64, seed: 42 } as never);
const { appris } = entrainerLexiqueMultimodal();
const lexique = construireLexique(appris);
const snapshot = capturerSnapshot(reseau as never, "apercu");

mkdirSync("/tmp/apercu-multimodal", { recursive: true });

const prompts = [
  "un chat noir au bord de la mer au coucher de soleil",
  "un phare dans la tempête",
  "une ville néon la nuit",
  "une montagne enneigée à l'aube",
];

async function principal(): Promise<void> {
  const { default: sharp } = await import("sharp");
  for (const [i, prompt] of prompts.entries()) {
    const scene = analyserScene(prompt, lexique);
    const rendu = genererVisuelScene(prompt, "16:9", snapshot, scene);
    const png = await sharp(Buffer.from(rendu.svg), { density: 96 }).png().toBuffer();
    writeFileSync(`/tmp/apercu-multimodal/visuel-${i}.png`, png);
    console.log(`visuel-${i}.png ← « ${prompt} » (${rendu.meta.calques.join(", ")})`);
  }
  const scenes = analyserScenesMultiples("un phare dans la tempête. puis la ville la nuit sous la neige", lexique).filter((s) => s.sujet || s.cadre);
  const video = genererVideoScene("un phare dans la tempête. puis la ville la nuit sous la neige", 8, snapshot, scenes);
  writeFileSync("/tmp/apercu-multimodal/video.svg", video.svg);
  console.log("video.svg ← storyboard 2 scènes");
}

void principal();
