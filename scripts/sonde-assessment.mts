// Sonde locale du Assessment Engine — réponse RÉELLE du moteur neuronal.
// npx tsx scripts/sonde-assessment.mts
process.env.GEN3IA_BILLING_ENABLED = "false";

async function main() {
  // Cascade directe (contourne server-only de generateur.ts) : le même
  // chemin que genererQuizMoteur, via llm-json sans "server-only".
  const { generateStructuredForUser } = await import(
    "../lib/tools/agent-suite/llm-json.js"
  );
  const { QUIZ_SCHEMA } = await import("../lib/evaluation/generateur.js");

  const SYSTEME = `Tu es l'ASSESSMENT ENGINE de Gen3ia : tu génères des évaluations pédagogiques de qualité professionnelle.
Tu réponds STRICTEMENT en JSON selon ce schéma :
{ "title": string, "questions": [ { "question": string, "choices": string[] (2-6, QCM uniquement), "correctIndex": number (0-based, QCM uniquement), "expectedAnswer": string (réponse courte uniquement), "explanation": string } ] }
Règles :
- Langue : fr. EXACTEMENT 5 question(s).
- Format demandé : QCM (choices + correctIndex obligatoires).
- Chaque question évalue une notion DISTINCTE et significative du sujet.
- « explanation » : pourquoi la réponse est correcte (1-2 phrases).
- Distracteurs plausibles mais clairement faux ; jamais de « toutes les réponses ».
- AUCUN texte hors JSON.`;

  const consigne = [
    "Sujet / corpus à évaluer :",
    "la Révolution française",
    "",
    "Génère l'évaluation (5 question(s), format qcm).",
  ].join("\n");

  try {
    const quiz = await generateStructuredForUser({
      userId: "sonde_locale",
      executionId: `assessment_${Date.now()}`,
      task: "reasoning",
      system: SYSTEME,
      user: consigne,
      schema: QUIZ_SCHEMA,
      maxTokens: 6000,
      maxAttempts: 2,
    });
    console.log("RÉSULTAT: quiz OK —", quiz.title, "—", quiz.questions.length, "question(s)");
    console.log(JSON.stringify(quiz, null, 2).slice(0, 1200));
  } catch (e) {
    console.log("RÉSULTAT: ÉCHEC —", e instanceof Error ? e.message : e);
  }
}

main().catch((e) => {
  console.error("ERREUR sonde:", e instanceof Error ? e.message : e);
  process.exit(1);
});
