import "server-only";
import { z } from "zod";
import { adminDb } from "@/lib/firebase/admin";
import { emitBusinessEvent } from "./events";

/**
 * Moteur 4 — Scheduling Engine.
 *
 * Calendrier unifié de la plateforme : rendez-vous commerciaux, échéances
 * (relances, SLA RGPD), congés, interventions de maintenance et rappels.
 * Un seul type d'entité (`calendarEvents`) discriminé par `type`, ce qui
 * permet aux modules de partager vue d'ensemble, rappels et automatisations
 * sans duplications.
 *
 * Fonctions pures exportées (testées) : jours ouvrés d'un congé, prochaine
 * échéance de maintenance, statut de maintenance dérivé.
 */

export const CALENDAR_COLLECTION = "calendarEvents";

export const CalendarEventTypeSchema = z.enum(["appointment", "deadline", "leave", "maintenance", "reminder"]);
export type CalendarEventType = z.infer<typeof CalendarEventTypeSchema>;

export const CalendarEventStatusSchema = z.enum(["planned", "confirmed", "completed", "cancelled"]);
export type CalendarEventStatus = z.infer<typeof CalendarEventStatusSchema>;

export const CalendarEventCreateSchema = z.object({
  userId: z.string().min(1).max(128),
  type: CalendarEventTypeSchema,
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2_000).optional(),
  startAt: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/, "Date de début invalide")),
  endAt: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/)).optional(),
  allDay: z.boolean().default(false),
  status: CalendarEventStatusSchema.default("planned"),
  related: z
    .object({
      module: z.string().max(60),
      refId: z.string().max(160),
    })
    .optional(),
});

export type CalendarEventCreate = z.input<typeof CalendarEventCreateSchema>;

export interface CalendarEvent {
  id: string;
  userId: string;
  type: CalendarEventType;
  title: string;
  description?: string;
  startAt: string;
  endAt?: string;
  allDay: boolean;
  status: CalendarEventStatus;
  related?: { module: string; refId: string };
  createdAt: number;
  updatedAt: number;
}

export async function createEvent(input: CalendarEventCreate): Promise<CalendarEvent> {
  const parsed = CalendarEventCreateSchema.parse(input);
  const now = Date.now();
  const ref = adminDb.collection(CALENDAR_COLLECTION).doc();
  const event: CalendarEvent = {
    id: ref.id,
    userId: parsed.userId,
    type: parsed.type,
    title: parsed.title,
    ...(parsed.description ? { description: parsed.description } : {}),
    startAt: parsed.startAt,
    ...(parsed.endAt ? { endAt: parsed.endAt } : {}),
    allDay: parsed.allDay,
    status: parsed.status,
    ...(parsed.related ? { related: parsed.related } : {}),
    createdAt: now,
    updatedAt: now,
  };
  await ref.set(event);

  // Hook d'automatisation : les workflows de l'utilisateur peuvent écouter
  // la création d'événements (ex. "quand un rendez-vous est créé, préparer
  // un compte-rendu"). Émission best-effort, jamais bloquante.
  void emitBusinessEvent({
    userId: parsed.userId,
    eventType: "calendar.event_created",
    payload: { eventId: event.id, type: event.type, title: event.title, startAt: event.startAt },
  }).catch(() => undefined);

  return event;
}

export interface ListEventsOptions {
  userId: string;
  types?: CalendarEventType[];
  from?: string;
  to?: string;
  status?: CalendarEventStatus;
  limit?: number;
}

export async function listEvents(options: ListEventsOptions): Promise<CalendarEvent[]> {
  let query = adminDb.collection(CALENDAR_COLLECTION).where("userId", "==", options.userId) as import("firebase-admin/firestore").Query;
  if (options.status) query = query.where("status", "==", options.status);
  if (options.types && options.types.length === 1) query = query.where("type", "==", options.types[0]);
  if (options.from) query = query.where("startAt", ">=", options.from);
  if (options.to) query = query.where("startAt", "<=", options.to);
  query = query.orderBy("startAt", "asc").limit(Math.min(options.limit ?? 100, 250));
  const snap = await query.get();
  return snap.docs.map((doc) => doc.data() as CalendarEvent);
}

export async function getEvent(userId: string, eventId: string): Promise<CalendarEvent | null> {
  const snap = await adminDb.collection(CALENDAR_COLLECTION).doc(eventId).get();
  if (!snap.exists) return null;
  const event = snap.data() as CalendarEvent;
  return event.userId === userId ? event : null;
}

export async function updateEvent(
  userId: string,
  eventId: string,
  patch: Partial<Pick<CalendarEvent, "title" | "description" | "startAt" | "endAt" | "status" | "allDay">>,
): Promise<CalendarEvent> {
  const existing = await getEvent(userId, eventId);
  if (!existing) throw new Error("Événement introuvable.");
  const now = Date.now();
  await adminDb.collection(CALENDAR_COLLECTION).doc(eventId).update({ ...patch, updatedAt: now });
  return { ...existing, ...patch, updatedAt: now };
}

export async function deleteEvent(userId: string, eventId: string): Promise<boolean> {
  const existing = await getEvent(userId, eventId);
  if (!existing) return false;
  await adminDb.collection(CALENDAR_COLLECTION).doc(eventId).delete();
  return true;
}

export async function upcomingEvents(userId: string, limit = 10): Promise<CalendarEvent[]> {
  const from = new Date().toISOString();
  return listEvents({ userId, from, limit });
}

/* ------------------------------------------------------------------ */
/* Fonctions pures (testées)                                          */
/* ------------------------------------------------------------------ */

/** Jours ouvrés inclus dans [startAt, endAt] (week-ends exclus). */
export function leaveBusinessDays(startAt: string, endAt: string): number {
  const start = new Date(`${startAt.slice(0, 10)}T00:00:00Z`);
  const end = new Date(`${endAt.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  if (end < start) return 0;
  let count = 0;
  const cursor = new Date(start);
  while (cursor <= end) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

/** Prochaine échéance de maintenance à partir de la dernière intervention. */
export function nextMaintenanceDue(lastDoneAt: string, intervalDays: number): string {
  const base = new Date(lastDoneAt);
  if (Number.isNaN(base.getTime())) throw new Error("Date de maintenance invalide.");
  base.setUTCDate(base.getUTCDate() + Math.max(intervalDays, 1));
  return base.toISOString();
}

/** Statut dérivé d'un actif : à quelle distance est l'échéance ? */
export type MaintenanceStatus = "ok" | "due_soon" | "overdue";

export function maintenanceStatus(nextDueAt: string, now: Date = new Date(), soonWindowDays = 7): MaintenanceStatus {
  const due = new Date(nextDueAt).getTime();
  if (Number.isNaN(due)) return "overdue";
  if (due <= now.getTime()) return "overdue";
  if (due - now.getTime() <= soonWindowDays * 24 * 60 * 60 * 1000) return "due_soon";
  return "ok";
}
