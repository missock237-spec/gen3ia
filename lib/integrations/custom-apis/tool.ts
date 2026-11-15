import { z } from "zod";

import { CUSTOM_API_MAX_BODY_CHARS } from "./client";
import { executeCustomApiCall } from "./client";
import type { ToolDefinition } from "@/lib/tools/types";

/**
 * Outils « API personnelles » : ils appellent RÉELLEMENT l'API déclarée par
 * l'utilisateur (fetch serveur signé avec son authentification) et restituent
 * la réponse réelle. La lecture (GET) s'exécute directement ; toute écriture
 * (POST/PUT/PATCH/DELETE) est sensible et passe par la validation humaine.
 */

const queryHeadersSchema = z.record(z.string().min(1).max(200), z.string().max(2000));

const limitedQuery = queryHeadersSchema.refine((value) => Object.keys(value).length <= 20, "20 paramètres maximum");
const limitedHeaders = queryHeadersSchema.refine((value) => Object.keys(value).length <= 10, "10 en-têtes maximum");

const CallInputSchema = z.object({
  apiId: z.string().trim().min(1).max(128).optional(),
  apiName: z.string().trim().min(1).max(120).optional(),
  method: z.enum(["GET"]).default("GET"),
  path: z.string().trim().max(500).default(""),
  query: limitedQuery.optional(),
  headers: limitedHeaders.optional(),
});

const WriteInputSchema = z.object({
  apiId: z.string().trim().min(1).max(128).optional(),
  apiName: z.string().trim().min(1).max(120).optional(),
  method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().trim().max(500).default(""),
  query: limitedQuery.optional(),
  headers: limitedHeaders.optional(),
  body: z.union([z.string().max(CUSTOM_API_MAX_BODY_CHARS), z.record(z.string(), z.unknown())]).optional(),
});

export const customApiCallTool: ToolDefinition<z.infer<typeof CallInputSchema>> = {
  name: "custom_api.call",
  description:
    "Appelle RÉELLEMENT une API personnelle fournie par l'utilisateur (GET) et retourne la réponse réelle. " +
    "Input : { apiName?: string, apiId?: string, path?: string (ex. \"/users/1\"), query?: {…}, headers?: {…} }. " +
    "Si plusieurs API existent, précisez apiName (nom exact tel qu'enregistré).",
  category: "http",
  risk: "medium",
  inputSchema: CallInputSchema,
  async execute(input, context) {
    return executeCustomApiCall(context.userId, { ...input, method: "GET" });
  },
};

export const customApiWriteTool: ToolDefinition<z.infer<typeof WriteInputSchema>> = {
  name: "custom_api.write",
  description:
    "Modifie RÉELLEMENT des données dans une API personnelle fournie par l'utilisateur (POST/PUT/PATCH/DELETE — action externe soumise à validation humaine). " +
    "Input : { apiName?: string, apiId?: string, method: \"POST\"|\"PUT\"|\"PATCH\"|\"DELETE\", path?: string, query?: {…}, headers?: {…}, body?: string|objet }.",
  category: "http",
  risk: "high",
  inputSchema: WriteInputSchema,
  async execute(input, context) {
    return executeCustomApiCall(context.userId, input);
  },
};
