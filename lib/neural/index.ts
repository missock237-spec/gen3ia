/**
 * Barrel PUBLIC de lib/neural — UNIQUEMENT les modules purs (testables sans
 * serveur) : noyau, corps sémantique, encodage, décodage.
 *
 * ATTENTION (Tâche 3+) : les modules serveur `engine.ts`, `runtime.ts` et
 * `training/*` portent `import "server-only"` et doivent être importés par
 * chemin direct, par exemple :
 *   import { getNeuralRuntime } from "@/lib/neural/runtime";
 *   import { NeuralEngine } from "@/lib/neural/engine";
 * Ils ne sont volontairement PAS ré-exportés ici pour garder ce barrel
 * importable depuis du code client (types notamment).
 */
export * from "./core";
export * from "./encoding/text-encoder";
export * from "./decoding/response-decoder";
export * from "./effectors";
