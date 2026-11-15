import "server-only";

import { adminDb } from "@/lib/firebase/admin";
import { createNotification } from "@/lib/notifications/repository";

/**
 * GESTIONNAIRE DE BUDGET DE TOKENS (intentions du commit 28fb610, intégrées
 * au standard du projet).
 *
 * Correctif d'intégration (Task 127) : le module d'origine référençait des
 * types hallucinés (Budget/TokenUsage non définis, `db`/`serverTimestamp`
 * inexistants, méthodes privées non déclarées) et ne compilait pas. Ici :
 * suivi d'usage Firestore (adminDb/r2fs) + seuils d'alerte notifiés à
 * l'utilisateur — la FACTURATION officielle reste lib/billing/ (wallet,
 * minor units XAF) ; ce module outille les budgets TOKENS journaliers.
 */

export interface TokenUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
}

export interface UserTokenBudget {
  /** Limite journalière en tokens. */
  dailyLimit: number;
}

const DEFAULT_DAILY_LIMIT = 500_000;

/** Prix par millier de tokens (EUR — ordre de grandeur, ajustable). */
const PRICING_PER_1K: Record<string, { input: number; output: number }> = {
  "gpt-4": { input: 0.03, output: 0.06 },
  "gpt-3.5-turbo": { input: 0.0015, output: 0.002 },
  "groq-mixtral": { input: 0.0006, output: 0.0006 },
};

export class TokenBudgetManager {
  /** Le budget de l'utilisateur reste-t-il suffisant pour estTokens ? */
  async checkBudget(userId: string, estimatedTokens: number): Promise<boolean> {
    const budget = await this.getUserBudget(userId);
    const usage = await this.getTodayUsage(userId);
    return budget.dailyLimit - usage.tokensUsed >= estimatedTokens;
  }

  /** Enregistre un usage et vérifie les seuils d'alerte. */
  async trackUsage(userId: string, agentId: string, usage: TokenUsage): Promise<void> {
    await adminDb.collection("tokenUsage").add({
      userId,
      agentId,
      model: usage.model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      costEur: this.calculateCost(usage),
      timestamp: new Date().toISOString(),
    });
    await this.checkThresholds(userId);
  }

  /** Budget de l'utilisateur (défaut : 500k tokens/jour). */
  async getUserBudget(userId: string): Promise<UserTokenBudget> {
    const snap = await adminDb.collection("users").doc(userId).get();
    if (!snap.exists) return { dailyLimit: DEFAULT_DAILY_LIMIT };
    const data = snap.data() as { tokenBudget?: { dailyLimit?: number } };
    const limit = data.tokenBudget?.dailyLimit;
    return { dailyLimit: typeof limit === "number" && limit > 0 ? limit : DEFAULT_DAILY_LIMIT };
  }

  /** Usage agrégé du jour (UTC) de l'utilisateur. */
  async getTodayUsage(userId: string): Promise<{ tokensUsed: number; costEur: number }> {
    const dayKey = new Date().toISOString().slice(0, 10);
    const snap = await adminDb.collection("tokenUsageDaily").doc(`${userId}_${dayKey}`).get();
    if (!snap.exists) return { tokensUsed: 0, costEur: 0 };
    const data = snap.data() as { tokensUsed?: number; costEur?: number };
    return { tokensUsed: data.tokensUsed ?? 0, costEur: data.costEur ?? 0 };
  }

  /** Coût estimé d'un usage (EUR). */
  private calculateCost(usage: TokenUsage): number {
    const pricing = PRICING_PER_1K[usage.model] ?? PRICING_PER_1K["gpt-3.5-turbo"];
    return (usage.promptTokens * pricing.input) / 1000 + (usage.completionTokens * pricing.output) / 1000;
  }

  /** Seuils 75 % / 90 % → notification utilisateur (best-effort). */
  private async checkThresholds(userId: string): Promise<void> {
    const [usage, budget] = await Promise.all([this.getTodayUsage(userId), this.getUserBudget(userId)]);
    const percentage = (usage.tokensUsed / Math.max(1, budget.dailyLimit)) * 100;
    if (percentage >= 90) {
      await this.sendAlert(userId, "90 % de votre budget quotidien de tokens est utilisé.");
    } else if (percentage >= 75) {
      await this.sendAlert(userId, "75 % de votre budget quotidien de tokens est utilisé.");
    }
  }

  /** Notification in-app (best-effort : jamais bloquant pour l'usage). */
  private async sendAlert(userId: string, message: string): Promise<void> {
    await createNotification({ userId, type: "info", title: "Budget de tokens", body: message }).catch(() => undefined);
  }
}
