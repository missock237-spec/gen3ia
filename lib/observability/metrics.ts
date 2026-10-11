import { Metrics } from '@opentelemetry/api';

// Métriques custom
export class Gen3iaMetrics {
  private static meter = Metrics.getMeter('gen3ia');
  
  // Compteurs
  static agentExecutions = Gen3iaMetrics.meter.createCounter('agent_executions_total', {
    description: 'Total agent executions',
  });
  
  static apiLatency = Gen3iaMetrics.meter.createHistogram('api_latency_ms', {
    description: 'API latency in milliseconds',
  });
  
  static tokenUsage = Gen3iaMetrics.meter.createHistogram('token_usage', {
    description: 'LLM token usage per request',
  });
  
  static errorRate = Gen3iaMetrics.meter.createCounter('errors_total', {
    description: 'Total errors by type',
  });
  
  // Enregistrer une exécution d'agent
  static recordExecution(agentId: string, duration: number, success: boolean) {
    this.agentExecutions.add(1, { agent_id: agentId, success });
    this.apiLatency.record(duration, { agent_id: agentId });
  }
  
  // Enregistrer l'usage de tokens
  static recordTokens(agentId: string, prompt: number, completion: number) {
    this.tokenUsage.record(prompt + completion, { 
      agent_id: agentId,
      type: 'prompt',
      tokens_prompt: prompt,
      tokens_completion: completion,
    });
  }
}

// Dashboard de monitoring
export async function getSystemHealth() {
  const metrics = {
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    activeAgents: await getActiveAgentCount(),
    queuedTasks: await getQueuedTaskCount(),
    errorRate24h: await getErrorRate(),
    avgLatency: await getAvgLatency(),
    tokenUsageToday: await getTodayTokenUsage(),
  };
  
  return {
    status: metrics.errorRate24h < 0.01 ? 'healthy' : 'degraded',
    ...metrics,
  };
    }
