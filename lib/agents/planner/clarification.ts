import { generate } from "@/lib/ai/router";
import { z } from "zod";

import { extractJsonObject } from "./normalize";

const ClarificationSchema=z.object({
  needsClarification:z.boolean(),
  questions:z.array(z.object({id:z.string().min(1).max(100),question:z.string().min(1).max(1000),reason:z.string().max(1000).optional(),required:z.boolean().default(true)})).max(8),
});
export type PlanClarification=z.infer<typeof ClarificationSchema>;

/**
 * Repli heuristique : si le provider LLM est en panne ou répond du JSON
 * irréparable, le mode plan doit continuer de fonctionner. On pose alors une
 * seule question générique non bloquante (required=false) — jamais d'erreur
 * 500 côté route clarify pour une panne de provider.
 */
function repliHeuristique(objective:string):PlanClarification{
  const extrait=objective.trim().slice(0,160);
  return {
    needsClarification:true,
    questions:[{
      id:"scope",
      question:`Pour l'objectif « ${extrait} », y a-t-il des contraintes importantes (délai, format de sortie, public, outils à utiliser ou à éviter) avant de construire le plan ?`,
      reason:"Précisions facultatives demandées faute d'analyse LLM disponible.",
      required:false,
    }],
  };
}

export async function analyzePlanClarifications(objective:string,context?:string):Promise<PlanClarification>{
  try{
    const response=await generate({task:"reasoning",messages:[
      {role:"system",content:"You are the Gen3ia Plan Mode clarification engine. Detect only information that is genuinely necessary to execute the user objective correctly. Do not ask questions when reasonable defaults are safe. Never ask for passwords, API keys, secrets or other credentials. Return JSON only."},
      {role:"user",content:"OBJECTIVE:\n"+objective+"\n\nCONTEXT:\n"+(context?.slice(0,20000)??"")+"\n\nReturn {needsClarification,questions:[{id,question,reason,required}]}. Ask concise questions about missing scope, target, output format, constraints, permissions or destructive actions."}
    ],maxTokens:2000});
    const parsed=extractJsonObject(response.text);
    const result=ClarificationSchema.safeParse(parsed);
    if(!result.success){
      // Réponse inutilisable : repli heuristique plutôt qu'un échec brut.
      return {needsClarification:false,questions:[]};
    }
    return result.data;
  }catch(error){
    // Panne provider / réseau : la clarification n'est qu'une étape
    // d'aide — on dégrade proprement au lieu de casser le mode plan.
    console.warn("[planner] Clarification LLM indisponible, repli heuristique:",error instanceof Error?error.message:error);
    return repliHeuristique(objective);
  }
}
