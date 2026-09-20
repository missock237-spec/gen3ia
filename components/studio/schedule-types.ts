/**
 * Types et constantes partagés de la planification d'agents.
 * Consommés par la page /studio/schedules, le formulaire et les cartes.
 */

export type Agent = { id: string; name: string; status: string; type: string };

export type Schedule = {
  id: string;
  agentId: string;
  name: string;
  objective: string;
  timezone: string;
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  intervalMinutes: number;
  enabled: boolean;
  maxRetries: number;
  retryDelayMinutes: number;
  catchUp: boolean;
  maxCatchUpRuns: number;
  nextRunAt?: string;
  lastExecutionStatus?: string;
  lastExecutionAt?: string;
  lastError?: string;
};

export type ScheduleRun = {
  id: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
};

/** [valeur JS, libellé court] — l'ordre suit la semaine affichée. */
export const DAYS = [
  [1, "Lun"], [2, "Mar"], [3, "Mer"], [4, "Jeu"], [5, "Ven"], [6, "Sam"], [0, "Dim"],
] as const;

export type ScheduleDraft = {
  name: string;
  agentId: string;
  objective: string;
  timezone: string;
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  intervalMinutes: number;
  maxRetries: number;
  retryDelayMinutes: number;
  catchUp: boolean;
  maxCatchUpRuns: number;
};

export function browserTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
  catch { return "UTC"; }
}
