import { AlertManager } from './alert-manager';

export class ProductionAlerts {
  static alertManager = new AlertManager({
    // Canaux d'alerte
    channels: {
      slack: process.env.SLACK_ALERT_WEBHOOK,
      email: {
        to: process.env.ALERT_EMAIL,
        from: 'alerts@gen3ia.com',
      },
      sms: process.env.ALERT_PHONE, // Pour incidents critiques
    },
    
    // Règles d'alerte
    rules: [
      {
        name: 'High Error Rate',
        condition: (metrics) => metrics.errorRate > 0.05, // >5%
        severity: 'critical',
        message: 'Error rate exceeded 5% in the last 5 minutes',
        cooldown: 300, // Pas plus d'une alerte toutes les 5 min
      },
      {
        name: 'High Latency',
        condition: (metrics) => metrics.p95Latency > 3000, // >3s
        severity: 'warning',
        message: 'P95 latency exceeded 3 seconds',
      },
      {
        name: 'Token Budget Alert',
        condition: (metrics) => metrics.dailyTokenUsage > 0.8 * metrics.dailyTokenLimit,
        severity: 'warning',
        message: 'Approaching daily token budget limit',
      },
      {
        name: 'Agent Failure Spike',
        condition: (metrics) => metrics.agentFailureRate > 0.1,
        severity: 'critical',
        message: 'Agent failure rate exceeded 10%',
      },
    ],
  });
  
  static async checkAndAlert() {
    const metrics = await this.collectMetrics();
    await this.alertManager.evaluate(metrics);
  }
}
