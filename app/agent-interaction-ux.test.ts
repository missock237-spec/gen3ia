import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Task 141 — interaction composer : verrouillage STRUCTUREL des axes
 * conservés, selon la convention du dépôt (lecture des sources — cf.
 * theme-consistency) pour empêcher toute régression future.
 *
 *  2. SÉLECTEUR DE MOTEUR IA — quel modèle rédige (pill + /moteur) ;
 *  3. MODÈLES DE PROMPTS — bibliothèque personnelle réutilisable (/modèle) ;
 *  4. ACTIONS RAPIDES — Copier / Réutiliser / Régénérer sur les réponses ;
 *  5. CHIPS DE SUIVI — suggestions cliquables sous la dernière réponse ;
 *  6. GLISSER-DÉPOSER de fichiers sur toute la zone du composer.
 *
 * + Câblage moteur : agentId (missions/automatisations uniquement — le
 *   sélecteur d'agent universel est supprimé de l'UI et de l'espace
 *   conversation ; l'API serveur reste compatible missions).
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const COMPOSER = "components/workspace/composer/composer.tsx";
const WORKSPACE = "components/workspace/conversation-workspace.tsx";
const THREAD = "components/workspace/message-thread.tsx";
const TEMPLATE_MENU = "components/workspace/composer/template-menu.tsx";
const ENGINE = "lib/domain/conversations/engine.ts";
const STREAM_ROUTE = "app/api/workspace/conversations/[conversationId]/messages/stream/route.ts";
const TYPES = "lib/domain/conversations/types.ts";

describe("Task 141 — axe 2 : SÉLECTEUR DE MOTEUR IA (quel modèle rédige)", () => {
  const composer = read(COMPOSER);

  it("« Auto » ne fixe AUCUN provider (le routeur résilient reste maître)", () => {
    expect(composer).toContain("...(modelChoice?.provider ? { provider: modelChoice.provider, model: modelChoice.model } : {})");
  });
});

describe("Task 141 — axe 3 : MODÈLES DE PROMPTS (/modèle)", () => {
  const menu = read(TEMPLATE_MENU);
  const composer = read(COMPOSER);

  it("le menu liste, insère et supprime des modèles personnels", () => {
    expect(menu).toContain('"/api/workspace/prompt-templates"');
    expect(menu).toContain("onInsert");
    expect(menu).toContain("Enregistrer le brouillon actuel");
  });

  it("l'insertion CONSERVE le brouillon en cours (ajout à la suite, rien d'écrasé)", () => {
    expect(composer).toContain("current.trim().length === 0 ? body : `${current}\\n\\n${body}`");
  });

  it("la commande « /modèle » ouvre la bibliothèque", () => {
    expect(composer).toContain('"Modèles de prompts"');
    expect(composer).toContain("setTemplateMenuOpen(true)");
  });
});

describe("Task 141 — axe 4 : ACTIONS RAPIDES sur les réponses", () => {
  const thread = read(THREAD);

  it("chaque réponse porte Copier (avec retour visuel) et Réutiliser", () => {
    expect(thread).toContain("navigator.clipboard.writeText(message.content)");
    expect(thread).toContain('"Copié" : "Copier"');
    expect(thread).toContain("Réutiliser");
  });

  it("Régénérer n'existe QUE sur la dernière réponse résolue (jamais les anciennes)", () => {
    expect(thread).toContain("isLastResolvedAssistant && onRegenerate && !generating");
    expect(thread).toContain("const lastResolvedAssistantId = useMemo");
  });

  it("l'espace de travail câble la régénération sur le dernier message utilisateur", () => {
    const workspace = read(WORKSPACE);
    expect(workspace).toContain("const handleRegenerate = useCallback");
    expect(workspace).toContain('message.role === "user"');
    expect(workspace).toContain("onRegenerate={handleRegenerate}");
  });
});

describe("Task 141 — axe 5 : CHIPS DE SUIVI cliquables", () => {
  const thread = read(THREAD);
  const types = read(TYPES);

  it("les suggestions sont portées par le message persisté (types)", () => {
    expect(types).toContain("suggestions?: string[];");
  });

  it("les chips s'affichent sous la DERNIÈRE réponse résolue, hors génération", () => {
    expect(thread).toContain('aria-label="Suggestions de suivi"');
    expect(thread).toContain("(message.suggestions ?? []).length > 0");
  });

  it("un clic INJECTE la suggestion dans le composer — jamais d'envoi automatique", () => {
    expect(thread).toContain("onClick={() => onPrefill(suggestion)}");
    const composer = read(COMPOSER);
    expect(composer).toContain("prefill");
  });
});

describe("Task 141 — axe 6 : GLISSER-DÉPOSER de fichiers", () => {
  const composer = read(COMPOSER);

  it("toute la zone du composer est une zone de dépôt (overlay + compteur de profondeur)", () => {
    expect(composer).toContain("onDragOver={onDragOver}");
    expect(composer).toContain("onDrop={onDrop}");
    expect(composer).toContain("dragDepthRef");
    expect(composer).toContain("Déposez vos fichiers");
  });

  it("chaque fichier déposé passe par le MÊME canal que le bouton « + »", () => {
    expect(composer).toContain("for (const file of Array.from(event.dataTransfer.files)) void uploadFile(file);");
  });
});

describe("Task 141 — câblage moteur (agentId de bout en bout)", () => {
  const engine = read(ENGINE);
  const route = read(STREAM_ROUTE);

  it("la route de streaming accepte et transmet l'agentId", () => {
    expect(route).toContain("agentId: z.string().trim().min(1).max(128).optional()");
    expect(route).toContain("agentId: body.agentId");
  });

  it("le moteur charge l'agent, injecte sa charte et retombe sur Gen IA en silence", () => {
    expect(engine).toContain("async function loadTurnAgent");
    expect(engine).toContain("input = { ...input, provider: agent.provider, model: input.model ?? agent.model }");
    expect(engine).toContain("La charte de cet agent prime sur ton identité par défaut");
    // Repli silencieux : un agent introuvable ne bloque JAMAIS le tour.
    expect(engine).toContain("repli silencieux sur Gen IA");
  });

  it("la réponse persiste l'agent du tour (badge ◈ dans le fil) et ses suggestions", () => {
    expect(engine).toContain("...(ctx.agent ? { agentId: ctx.agent.id, agentName: ctx.agent.name } : {})");
    expect(engine).toContain("suggestions: buildFollowUpSuggestions(ctx.message, content)");
    expect(read(THREAD)).toContain("{message.agentName}");
  });

});
