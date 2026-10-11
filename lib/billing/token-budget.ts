export class TokenBudgetManager {
  private budgets = new Map<string, Budget>();
  
  async checkBudget(userId: string, estimatedTokens: number): Promise<boolean> {
    const user = await this.getUserBudget(userId);
    const todayUsage = await this.getTodayUsage(userId);
    
    const remaining = user.dailyLimit - todayUsage.tokensUsed;
    return remaining >= estimatedTokens;
  }
  
  async trackUsage(userId: string, agentId: string, usage: TokenUsage) {
    // Enregistrer l'usage
    await db.collection('tokenUsage').add({
      userId,
      agentId,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cost: this.calculateCost(usage),
      timestamp: serverTimestamp(),
    });
    
    // Mettre à jour les agrégats
    await this.updateAggregates(userId, usage);
    
    // Vérifier les seuils d'alerte
    await this.checkThresholds(userId);
  }
  
  private calculateCost(usage: TokenUsage): number {
    // Coûts par modèle (à mettre à jour régulièrement)
    const pricing = {
      'gpt-4': { input: 0.03 / 1000, output: 0.06 / 1000 },
      'gpt-3.5-turbo': { input: 0.0015 / 1000, output: 0.002 / 1000 },
      'groq-mixtral': { input: 0.0006 / 1000, output: 0.0006 / 1000 },
    };
    
    const model = pricing[usage.model] || pricing['gpt-3.5-turbo'];
    return (usage.promptTokens * model.input) + 
           (usage.completionTokens * model.output);
  }
  
  private async checkThresholds(userId: string) {
    const usage = await this.getTodayUsage(userId);
    const budget = await this.getUserBudget(userId);
    
    const percentage = (usage.tokensUsed / budget.dailyLimit) * 100;
    
    if (percentage >= 90) {
      await this.sendAlert(userId, '90% du budget quotidien utilisé');
    } else if (percentage >= 75) {
      await this.sendAlert(userId, '75% du budget quotidien utilisé');
    }
  }
}
