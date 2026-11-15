/**
 * Index des 6 moteurs communs de GEN3IA.
 * Import recommandé pour les modules métier : `@/lib/engines`.
 */
export { runAI, runAIJSON, extractJsonObject } from "./ai-engine";
export type { RunAIInput, RunAIResult, RunAIJSONInput, RunAIJSONResult } from "./ai-engine";

export { buildDocument, proofDocument, blocksFromMarkdown } from "./document-engine";
export type { BuildDocumentInput, BuiltDocument, DocumentFormat } from "./document-engine";

export {
  createWorkflow,
  listWorkflows,
  getWorkflow,
  updateWorkflow,
  deleteWorkflow,
  runWorkflow,
  dispatchEvent,
  listRuns,
  listNotifications,
  interpolate,
  interpolateConfig,
  evaluateConditions,
  resolveFlexibleDate,
  WORKFLOW_COLLECTION,
  RUNS_COLLECTION,
  NOTIFICATIONS_COLLECTION,
} from "./workflow-engine";
export type { BusinessWorkflow, BusinessWorkflowInput, WorkflowRun, WorkflowRunStep } from "./workflow-engine";

export {
  createEvent,
  listEvents,
  getEvent,
  updateEvent,
  deleteEvent,
  upcomingEvents,
  leaveBusinessDays,
  nextMaintenanceDue,
  maintenanceStatus,
  CALENDAR_COLLECTION,
} from "./scheduling-engine";
export type { CalendarEvent, CalendarEventCreate, CalendarEventType, CalendarEventStatus, MaintenanceStatus } from "./scheduling-engine";

export {
  summarizeNumbers,
  timeseriesByDay,
  getAtPath,
  linearForecast,
  forecastDaily,
  formatMoney,
  buildReport,
} from "./analytics-engine";
export type { NumberSummary, DayPoint, ForecastPoint, LinearForecast, BuildReportInput, BuildReportResult, ReportContent } from "./analytics-engine";

export {
  createRecord,
  getRecord,
  updateRecord,
  deleteRecord,
  listRecords,
  countRecords,
  unfoldRecord,
  DATA_COLLECTION_RE,
} from "./data-engine";
export type { BusinessRecord, ListRecordsFilter, ListRecordsOptions } from "./data-engine";

export { emitBusinessEvent } from "./events";
export { BUSINESS_EVENT_TYPES, nowIso, epochNow } from "./types";
export type { BusinessEventType, BusinessEventInput, EngineFeature, BusinessDocBase } from "./types";
