import type { AppNotification, AttemptHistoryItem, NotificationsResponse, RecommendationsResponse } from "@copilot/shared";

/** A result is "news" for this long; after that it lives in History / Progress, not in the bell. */
const RESULT_FRESH_MS = 3 * 24 * 3600_000;
const MAX_TODAY_ITEMS = 3;

export interface AgendaSession {
  id: string;
  date: string;
  subject: string;
  topic: string;
  durationMinutes: number;
  startTime: string | null;
}

export interface NotificationSources {
  /** Unfinished sessions of the active plan; null = no active plan. */
  openSessions(userId: string): Promise<{ day: string; today: AgendaSession[]; missed: AgendaSession[] } | null>;
  quizAttempts(userId: string): Promise<AttemptHistoryItem[]>;
  vivas(userId: string): Promise<Array<{ id: string; subject: string; topic: string | null; status: string; score: number | null; completedAt: Date | null }>>;
  /** The student's single top recommendation (the deterministic engine; no AI). */
  topRecommendation(userId: string): Promise<RecommendationsResponse["recommendations"][number] | null>;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * In-app notifications, derived on request from the student's real records. Nothing is stored, nothing is scheduled, nothing
 * is pushed and no AI model is involved. Each part is read independently: if one cannot be read the rest still shows and the
 * response says `partial`.
 */
export function createNotificationService(src: NotificationSources, opts: { now?: () => Date; onError?: (err: unknown) => void } = {}) {
  const now = opts.now ?? (() => new Date());
  const onError = opts.onError ?? (() => undefined);

  return {
    async list(userId: string): Promise<NotificationsResponse> {
      const t = now();
      const [openSessions, attempts, vivas, rec] = await Promise.allSettled([src.openSessions(userId), src.quizAttempts(userId), src.vivas(userId), src.topRecommendation(userId)]);
      let partial = false;
      const value = <T>(r: PromiseSettledResult<T>, fallback: T): T => {
        if (r.status === "fulfilled") return r.value;
        partial = true;
        onError(r.reason);
        return fallback;
      };
      const items: AppNotification[] = [];

      const plan = value(openSessions, null);
      if (plan && plan.missed.length > 0) {
        const first = plan.missed[0]!;
        items.push({
          id: `session_missed:${plan.missed.map((s) => s.id).sort().join(",").slice(0, 60)}`,
          kind: "session_missed",
          tone: "attention",
          title: `You have ${plural(plan.missed.length, "missed study session", "missed study sessions")}`,
          body: `${first.topic} (${first.subject}) was planned for ${first.date}. Reschedule it or keep it as missed.`,
          href: `/study-plan?session=${first.id}`,
          at: null,
        });
      }
      if (plan && plan.today.length > 0) {
        for (const s of plan.today.slice(0, MAX_TODAY_ITEMS)) {
          items.push({
            id: `session_today:${s.id}`,
            kind: "session_today",
            tone: "info",
            title: `Today: ${s.topic}`,
            body: `${s.subject} · ${s.durationMinutes} min${s.startTime ? ` · ${s.startTime.slice(0, 5)}` : ""}`,
            href: `/study-plan?session=${s.id}`,
            at: null,
          });
        }
      }

      for (const a of value(attempts, [] as AttemptHistoryItem[])) {
        if (a.status === "in_progress" || a.submittedAt === null || a.percentage === null || t.getTime() - Date.parse(a.submittedAt) > RESULT_FRESH_MS) continue;
        items.push({
          id: `quiz_result:${a.id}`,
          kind: "quiz_result",
          tone: "success",
          title: `Quiz result: ${a.score}/${a.total} (${Math.round(a.percentage)}%)`,
          body: a.quizTitle,
          href: `/quiz/attempt/${a.id}/result`,
          at: a.submittedAt,
        });
        break; // the latest one only
      }

      for (const v of value(vivas, [] as Awaited<ReturnType<NotificationSources["vivas"]>>)) {
        if (v.status !== "completed" || v.score === null || !v.completedAt || t.getTime() - v.completedAt.getTime() > RESULT_FRESH_MS) continue;
        items.push({
          id: `viva_result:${v.id}`,
          kind: "viva_result",
          tone: "success",
          title: `Viva result: ${Math.round(v.score)}%`,
          body: v.topic ?? v.subject,
          href: `/viva/${v.id}`,
          at: v.completedAt.toISOString(),
        });
        break;
      }

      const top = value(rec, null);
      if (top && top.type !== "MAINTAIN_STRENGTH" && top.type !== "IMPROVING") {
        items.push({ id: `recommendation:${top.id}`, kind: "recommendation", tone: top.priority === "high" ? "attention" : "info", title: top.title, body: top.reason, href: "/recommendations", at: null });
      }
      return { notifications: items, partial };
    },
  };
}

export type NotificationService = ReturnType<typeof createNotificationService>;
