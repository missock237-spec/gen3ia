/**
 * Détection déterministe des intentions « sous-services du projet ».
 *
 * Mission : toutes les sous-fonctionnalités de Gen3ia (tâches planifiées,
 * workflows, …) passent sous l'autorité de la conversation / des agents IA.
 * L'utilisateur énonce sa demande EN LANGAGE NATUREL ; ces détecteurs
 * déterministes (aucune variance LLM, aucune invention) identifient les
 * demandes claires et produisent l'entrée exacte des outils réels
 * (schedule.create / workflow.create / schedule.update / …).
 *
 * Principe anti-hallucination : une détection ne retourne QUE ce que
 * l'utilisateur a réellement énoncé. Si une information manque (heure,
 * jours, nom), une valeur par défaut HONNÊTE est fournie ET affichée dans
 * la confirmation ; l'utilisateur peut toujours la corriger.
 */

export interface ScheduleIntent {
  name: string;
  objective: string;
  /** 0 = dimanche … 6 = samedi. */
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  intervalMinutes?: number;
  /** Fenêtre explicite ou rappel par intervalle. */
  trigger: "window" | "interval";
}

export interface WorkflowIntent {
  name: string;
  objective: string;
  steps: Array<{ name: string; description: string }>;
  runNow: boolean;
}

export type ServiceControlIntent =
  | { target: "schedule"; action: "list" | "enable" | "disable" | "delete"; name?: string }
  | { target: "workflow"; action: "list" | "run" | "delete"; name?: string };

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

/**
 * Retire les segments cités (« … », "…", '…') du message : le contenu d'une
 * citation est une RÉFÉRENCE (nom d'une tâche existante), pas une demande —
 * il ne doit pas déclencher les détecteurs de création.
 */
export function sansCitations(message: string): string {
  return message.replace(/[«"']([^»"']*)[»"']/g, " ");
}

/* ------------------------------------------------------------------ */
/* Parsing : jours, heures, intervalles                                */
/* ------------------------------------------------------------------ */

const JOUR_PATTERNS: Array<{ jour: number; re: RegExp }> = [
  { jour: 1, re: /\blun(?:di|d)?s?\b/i },
  { jour: 2, re: /\bmar(?:di|d)?s?\b/i },
  { jour: 3, re: /\bmer(?:credi|c)?s?\b/i },
  { jour: 4, re: /\bjeu(?:di|d)?s?\b/i },
  { jour: 5, re: /\bven(?:dredi|d)?s?\b/i },
  { jour: 6, re: /\bsam(?:edi|i)?s?\b/i },
  { jour: 0, re: /\bdim(?:anche|d)?s?\b/i },
];

/** Extrait les jours de récurrence énoncés (null si aucun jour identifiable). */
export function extraireJours(message: string): number[] | null {
  const lower = message.toLowerCase();
  if (/\b(chaque jour|tous les jours|tous les matins|quotidien|daily|every day|chaque soir|tous les soirs|7\s?\/\s?7|7j7)\b/.test(lower)) {
    return [0, 1, 2, 3, 4, 5, 6];
  }
  if (/\b(du lundi au vendredi|lundi au vendredi|en semaine|jours ouvr[eé]s|weekdays|du lundi au samedi)\b/.test(lower)) {
    const duLundiAuSamedi = /lundi au samedi/.test(lower);
    return duLundiAuSamedi ? [1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5];
  }
  if (/\b(le week[- ]?end|weekend|week[- ]?ends)\b/.test(lower)) return [0, 6];
  const jours: number[] = [];
  for (const { jour, re } of JOUR_PATTERNS) {
    if (re.test(lower)) jours.push(jour);
  }
  return jours.length > 0 ? jours : null;
}

/** Extrait une heure « à 9h », « à 09:00 », « à 21h30 », « 9:30 » (HH:mm). */
export function extraireHeure(message: string): string | null {
  const match =
    /(?:à|a|@|at\s|de\s|vers\s)?\s*(\d{1,2})\s*[:hH]\s*(\d{2})/.exec(message) ??
    /(?:à|a|@|at)\s*(\d{1,2})\s*[hH](?!\w)/.exec(message) ??
    /(\d{1,2})\s*[hH](?![\d\w])/ .exec(message);
  if (!match) return null;
  const heures = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  if (heures < 0 || heures > 23 || minutes < 0 || minutes > 59) return null;
  const hh = String(heures).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Heure par défaut pour les moments flous (« le matin »…). */
export function extraireMoment(message: string): string | null {
  const lower = message.toLowerCase();
  if (/\b(le matin|chaque matin|tous les matins|matinal|t[oô]t le matin|each morning|every morning|in the morning)\b/.test(lower)) return "08:00";
  if (/\b(l'?apr[eè]s-?midi|afternoon)\b/.test(lower)) return "14:00";
  if (/\b(le soir|chaque soir|en soir[eé]e|tous les soirs|in the evening|each evening|every evening)\b/.test(lower)) return "18:00";
  if (/\b(la nuit|in the night)\b/.test(lower)) return "22:00";
  if (/\b(midi|noon)\b/.test(lower)) return "12:00";
  return null;
}

/** Extrait un intervalle « toutes les 30 minutes », « toutes les 2 heures ». */
export function extraireIntervalle(message: string): number | null {
  const minutes = /toutes?\s+les\s+(\d{1,3})\s*(min(?:ute)?s?|mns?)\b/i.exec(message);
  if (minutes) {
    const value = Number(minutes[1]);
    if (value >= 1 && value <= 1440) return value;
  }
  const heures = /toutes?\s+les\s+(\d{1,2})\s*(h(?:eures?)?|hours?)\b/i.exec(message);
  if (heures) {
    const value = Number(heures[1]) * 60;
    if (value >= 1 && value <= 1440) return value;
  }
  if (/toutes?\s+les\s+(demi[- ]?heure)s?/i.test(message)) return 30;
  if (/toutes?\s+les\s+(une?\s+heure|one hour)s?/i.test(message)) return 60;
  return null;
}

/* ------------------------------------------------------------------ */
/* Détection : création d'une tâche planifiée                          */
/* ------------------------------------------------------------------ */

/** Marqueurs de récurrence claire (toutes langues usuelles de la plateforme). */
const RECURRENCE_RE =
  /\b(chaque|tous les|toutes les|chaque jour|quotidien|quotidienne|chaque semaine|hebdomadaire|chaque mois|mensuel|chaque matin|chaque soir|de mani[eè]re r[eé]currente|p[eé]riodique|périodiquement|r[eé]guli[eè]rement|recurring|every|daily|weekly|each day|each week|7\s?\/\s?7|7j7|en boucle|automatiquement)\b/i;

/** Verbes qui lient la récurrence à une mise en place par un agent. */
const SCHEDULE_VERB_RE =
  /\b(planifi(?:e|er|e-?moi|és?)|programme(?:r|-?moi|s?)?|mets? en place|met en place|mettre en place|automatis(?:e|er|ation)|configure(?:r)?|schedul(?:e|ing)|lance(?:r)? automatiquement|ex[eé]cute(?:r)? automatiquement|g[eé]n[eè]re(?:r)? automatiquement|envoi(?:e|er)?[- ]moi automatiquement|rappelle[- ]moi)\b/i;

/**
 * Verbes d'action récurrente d'agent : le déclencheur temporel (« chaque
 * lundi à 9h, prépare-moi un rapport ») suffit à exprimer l'automatisation,
 * même sans le verbe « planifier ».
 */
const SCHEDULE_ACTION_RE =
  /\b(prépar(?:e|er|ez)|prepare|envoi(?:e|er|ez)|g[eé]n[eè]re(?:r|z)?|r[eé]dig(?:e|er|ez)|v[eé]rifi(?:e|er|ez)|surveill(?:e|er|ez)|analys(?:e|er|ez)|publi(?:e|er|ez)|collect(?:e|er|ez)|r[eé]sum(?:e|er|ez)|synth[eé]tis(?:e|er|ez)|contr[oô]l(?:e|er|ez)|rapport(?:e|er)|scrap(?:e|er)|extrais|suis(?:s-?moi)?|envoie-moi)\b/i;

/** Formulation à la première personne : un constat, PAS un ordre à l'agent. */
const PREMIERE_PERSONNE_RE = /\b(?:je|j'|nous|on)\s+(?:me\s+|nous\s+)?(?:pr[eé]par|envoi|g[eé]n[eè]r|r[eé]dig|v[eé]rifi|surveill|analys|publi|fais|collect|r[eé]sum|synth[eé]tis|pass|aim)/i;

/**
 * Détecte une demande de tâche planifiée RÉCURRENTE, formulée naturellement.
 * Retourne l'entrée exacte de schedule.create, ou null si la demande n'est
 * pas une planification claire (recurrence + verbe d'automatisation).
 */
export function detectScheduleIntent(message: string): ScheduleIntent | null {
  // Les citations sont des références (noms), jamais des demandes : un
  // message « désactive la tâche « chaque lundi… » » ne doit pas créer
  // une NOUVELLE tâche planifiée.
  const messageNettoyé = sansCitations(message);
  const lower = messageNettoyé.toLowerCase();

  // Intention de contrôle (désactive/supprime/liste…) : ce n'est pas une création.
  if (detectServiceControlIntent(messageNettoyé)) return null;

  // Constat à la première personne : pas une demande d'automatisation.
  if (PREMIERE_PERSONNE_RE.test(lower)) return null;

  if (!RECURRENCE_RE.test(lower)) return null;
  if (!SCHEDULE_VERB_RE.test(lower) && !SCHEDULE_ACTION_RE.test(lower)) return null;

  const intervalMinutes = extraireIntervalle(messageNettoyé);
  const jours = extraireJours(messageNettoyé) ?? [0, 1, 2, 3, 4, 5, 6];
  const heureExplicite = extraireHeure(messageNettoyé);
  const moment = extraireMoment(messageNettoyé);
  const startTime = heureExplicite ?? moment ?? (intervalMinutes ? "00:00" : "08:00");
  // Fenêtre par défaut honnête : toute la journée, affichée dans la
  // confirmation — l'utilisateur peut la resserrer (schedule.update).
  const endTime = "23:59";

  return {
    name: nomDepuisMessage(message, "Tâche planifiée"),
    objective: message.trim().slice(0, 5000),
    daysOfWeek: jours,
    startTime,
    endTime,
    ...(intervalMinutes !== null ? { intervalMinutes } : {}),
    trigger: intervalMinutes !== null ? "interval" : "window",
  };
}

/** Construit un nom court et lisible depuis la demande (pour listes/écrans). */
export function nomDepuisMessage(message: string, fallback: string): string {
  const nettoyé = message
    .replace(/\s+/g, " ")
    .replace(/^(planifie[rz]?|programme[rz]?|mets? en place|automatis[eé]|cr[eé]e[rz]?)\s+(moi\s+)?(une?\s+|la\s+|le\s+|des\s+)?/i, "")
    .trim();
  const base = nettoyé.length >= 8 ? nettoyé : message.trim();
  const court = base.slice(0, 80).trim();
  return court.length > 0 ? court : fallback;
}

/* ------------------------------------------------------------------ */
/* Détection : création d'un workflow                                  */
/* ------------------------------------------------------------------ */

const WORKFLOW_OBJECT_RE =
  /\b(workflows?|flux de travail|cha[iî]ne de traitement|cha[iî]ne d'automatisation|pipeline|s[eé]quence automatis[eé]e|automatisation (?:en )?(?:plusieurs )?[eé]tapes)\b/i;

const WORKFLOW_VERB_RE =
  /\b(cr[eé]e(?:r|-?moi|z)?|construis(?:re|-?moi)?|g[eé]n[eè]re(?:r|-?moi)?|mets? en place|met en place|configure(?:r|-?moi)?|d[eé]finis(?:s-?moi)?|fabriqu(?:e|er)|create|build|set up)\b/i;

/** Segmente la demande en étapes explicites (numérotées ou enchaînées). */
export function extraireEtapesWorkflow(message: string): Array<{ name: string; description: string }> | null {
  // 1) Étapes préfixées « étape N : » — extraction directe : l'introduction
  //    avant la première étape est exclue (ce n'est pas une étape).
  const prefixees = [...message.matchAll(/(?:étape|etape|step)\s*\d+\s*[:\-–]\s*([\s\S]+?)(?=(?:\s*(?:étape|etape|step)\s*\d+\s*[:\-–])|$)/gi)]
    .map((m) => (m[1] ?? "").replace(/\s*[.;,]\s*$/, "").trim())
    .filter((s) => s.length >= 3);
  if (prefixees.length >= 2 && prefixees.length <= 12) {
    return prefixees.map((segment, index) => ({
      name: `Étape ${index + 1} — ${segment.split(/[,:;]/)[0]!.slice(0, 60)}`,
      description: segment.slice(0, 2000),
    }));
  }

  // 2) Numérotation « 1) / 1. » : le segment d'introduction (avant le
  //    premier numéro) est écarté.
  if (/(?:^|\s)\d{1,2}\s*[).]/.test(message)) {
    const segments = message
      .split(/(?:^|\s)\d{1,2}\s*[).]\s+/)
      .map((s) => s.replace(/^\s*(?:[,;]|et|puis|ensuite|enfin|après)\s+/i, "").trim())
      .filter((s) => s.length >= 3);
    if (segments.length >= 2 && segments.length <= 12) {
      return segments.map((segment, index) => ({
        name: `Étape ${index + 1} — ${segment.split(/[,:;]/)[0]!.slice(0, 60)}`,
        description: segment.slice(0, 2000),
      }));
    }
  }

  // 3) Enchaînements explicites : « X puis Y puis Z »
  const chaine = message.split(/\s+(?:puis|ensuite|apr[eè]s quoi|after that|then)\s+/i).map((s) => s.trim());
  if (chaine.length >= 2 && chaine.length <= 12) {
    return chaine.map((segment, index) => ({
      name: `Étape ${index + 1} — ${segment.split(/[,:;]/)[0]!.slice(0, 60)}`,
      description: segment.slice(0, 2000),
    }));
  }

  return null;
}

/**
 * Détecte une demande de workflow RÉEL formulée naturellement. Les étapes
 * sont extraites si l'utilisateur les a énumérées ; sinon une étape unique
 * reprenant la demande exacte est créée (aucun contenu inventé).
 */
export function detectWorkflowIntent(message: string): WorkflowIntent | null {
  const messageNettoyé = sansCitations(message);
  const lower = messageNettoyé.toLowerCase();

  // Contrôle d'un workflow existant : ce n'est pas une création.
  if (detectServiceControlIntent(messageNettoyé)) return null;

  if (!WORKFLOW_OBJECT_RE.test(lower) || !WORKFLOW_VERB_RE.test(lower)) return null;

  const runNow =
    /\b(ex[eé]cute-?le|lance-?le|d[eé]marre-?le|ex[eé]cute-?la|lance-?la|et ex[eé]cute|et lance|et d[eé]marre|run it|ex[eé]cute-?le imm[eé]diatement|tout de suite|imm[eé]diatement apr[eè]s)\b/.test(lower);

  const steps = extraireEtapesWorkflow(messageNettoyé) ?? [
    {
      name: `Étape 1 — ${messageNettoyé.trim().slice(0, 60)}`,
      description: messageNettoyé.trim().slice(0, 2000),
    },
  ];

  return {
    name: nomWorkflowDepuisMessage(messageNettoyé, steps),
    objective: messageNettoyé.trim().slice(0, 2000),
    steps,
    runNow,
  };
}

/**
 * Nom de workflow lisible : l'introduction énoncée (avant l'énumération des
 * étapes), nettoyée des verbes de création ; si l'introduction est vide
 * (« crée un workflow : étape 1… »), on reprend le libellé de la première
 * étape — toujours un texte réellement énoncé par l'utilisateur.
 */
export function nomWorkflowDepuisMessage(
  message: string,
  steps: Array<{ name: string; description: string }>,
): string {
  const intro = message.split(/(?:étape|etape|step)\s*\d+|\s*[:：]\s*/i)[0] ?? "";
  const nettoyé = intro
    .replace(/^\s*(?:cr[eé]e[rz]?|construis(?:re)?|g[eé]n[eè]re[rz]?|mets? en place|met en place|configure[rz]?|d[eé]finis|fabriqu[eerz]?|create|build|set up)\s*/i, "")
    .replace(/\b(un|une|le|la|les|des|mon|ma|mes|de|du|d')\s*/gi, " ")
    .replace(/\b(workflows?|flux de travail|cha[iî]ne de traitement|pipeline|s[eé]quence automatis[eé]e|automatisation en [eé]tapes)\b/gi, "")
    .replace(/[\s:，,;.-]+$/g, "")
    .replace(/^\s+/, "")
    .trim();
  if (nettoyé.length >= 4) return nettoyé.slice(0, 80);
  const premiereEtape = steps[0]?.name.replace(/^Étape\s*\d+\s*[—-]\s*/, "").trim() ?? "Workflow";
  return (premiereEtape.length >= 4 ? premiereEtape : "Workflow").slice(0, 80);
}

/* ------------------------------------------------------------------ */
/* Détection : pilotage des sous-services existants                    */
/* ------------------------------------------------------------------ */

const SCHEDULE_TARGET_RE =
  /\b(t[aâ]ches? planifi[eé]e?s?|planifications?|t[aâ]che automatis[eé]e?s?|plannings? automatiques|schedules?|automatisations? r[eé]currentes?|rappel(?:s)? planifi[eé]e?s?)\b/i;

const WORKFLOW_TARGET_RE = /\b(workflows?|flux de travail|pipelines?|cha[iî]nes de traitement)\b/i;

const VERB_LIST_RE = /\b(liste|lister|affiche(?:r)?|montre(?:r|-?moi)?|vois?|voir|quelles sont|quels sont|donne[- ]moi|l'[eé]tat de|show|list)\b/i;
const VERB_DISABLE_RE = /\b(d[eé]sactiv(?:e|er|e-?la|e-?le)|arr[eê]t(?:e|er|es?)|stoppe(?:r)?|suspend(?:re)?|mets? en pause|met en pause|disable|stop)\b/i;
const VERB_ENABLE_RE = /\b(r[eé]activ(?:e|er)|activ(?:e|er)|relance(?:r)?|r[eé]enclench(?:e|er)|enable|resume)\b/i;
const VERB_DELETE_RE = /\b(supprim(?:e|er|es?|ons)|effac(?:e|er|es?)|enl[eè]v(?:e|er)|retir(?:e|er)|annul(?:e|er)|delete|remove)\b/i;
const VERB_RUN_RE = /\b(ex[eé]cut(?:e|er)|lanc(?:e|er)|d[eé]marr(?:e|er)|run|trigger)\b/i;

/** Extrait le nom cité (« … », « … », "…") ou introduit par « de la/du/la/le ». */
export function extraireNomCible(message: string): string | undefined {
  const guillemets = /[«"'"]([^»"']{2,80})[»"']/.exec(message);
  if (guillemets) return guillemets[1]!.trim();
  const introduit =
    /\b(?:de\s+la|du|de\s+le|la|le|mon|ma|mes)\s+(?:t[aâ]che(?:s)?\s+planifi(?:e|é)es?|planification|workflow|flux de travail|pipeline)\s+(.+)/i.exec(message);
  if (introduit) {
    const suite = introduit[1]!
      .replace(/\b(nomm[eé]e?|appel[eé]e?|qui|qui\s+[a-z]+)\b.*$/i, "")
      .replace(/[.!?…]+$/, "")
      .trim();
    if (suite.length >= 2 && suite.length <= 80) return suite;
  }
  return undefined;
}

/**
 * Détecte un pilotage naturel d'un sous-service existant :
 * lister, activer/désactiver, supprimer (tâches planifiées) ou
 * lister, exécuter, supprimer (workflows). Null si aucun pilotage clair.
 */
export function detectServiceControlIntent(message: string): ServiceControlIntent | null {
  // Le nom cité est extrait du message ORIGINAL (avec guillemets) ; les
  // marqueurs d'intention s'évaluent SANS les citations pour qu'une tâche
  // nommée « chaque lundi à 9h… » ne fasse pas croire à une création.
  const nom = extraireNomCible(message);
  const lower = sansCitations(message).toLowerCase();

  // PRIORITÉ À LA CRÉATION : « crée un workflow et exécute-le » ou
  // « chaque lundi, planifie-moi … » sont des demandes de CRÉATION, pas
  // un pilotage d'un sous-service existant.
  const creationWorkflow = WORKFLOW_OBJECT_RE.test(lower) && WORKFLOW_VERB_RE.test(lower);
  const creationSchedule =
    RECURRENCE_RE.test(lower) && (SCHEDULE_VERB_RE.test(lower) || SCHEDULE_ACTION_RE.test(lower));
  if (creationWorkflow || creationSchedule) return null;

  // Ordre d'évaluation : suppression > désactivation > activation > liste > exécution.
  if (SCHEDULE_TARGET_RE.test(lower)) {
    if (VERB_DELETE_RE.test(lower)) return { target: "schedule", action: "delete", ...(nom ? { name: nom } : {}) };
    if (VERB_DISABLE_RE.test(lower)) return { target: "schedule", action: "disable", ...(nom ? { name: nom } : {}) };
    if (VERB_ENABLE_RE.test(lower)) return { target: "schedule", action: "enable", ...(nom ? { name: nom } : {}) };
    if (VERB_LIST_RE.test(lower) || /\bmes\b/.test(lower)) {
      return { target: "schedule", action: "list", ...(nom ? { name: nom } : {}) };
    }
  }

  if (WORKFLOW_TARGET_RE.test(lower)) {
    if (VERB_DELETE_RE.test(lower)) return { target: "workflow", action: "delete", ...(nom ? { name: nom } : {}) };
    if (VERB_RUN_RE.test(lower)) return { target: "workflow", action: "run", ...(nom ? { name: nom } : {}) };
    if (VERB_LIST_RE.test(lower) || /\bmes\b/.test(lower)) {
      return { target: "workflow", action: "list", ...(nom ? { name: nom } : {}) };
    }
  }

  return null;
}
