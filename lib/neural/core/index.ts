/**
 * Barrel des modules du NOYAU NEURONAL (purs, testables sans serveur).
 * Les modules serveur (engine, runtime, training) vivent dans lib/neural/
 * directement et doivent être importés par chemin (server-only).
 */
export * from "./types";
export * from "./rng";
export * from "./neuron";
export * from "./synapse";
export * from "./network";
export * from "./resonant-space";
export * from "./auto-oscillation";
export * from "./central-core";
export * from "./couche-rpia";
