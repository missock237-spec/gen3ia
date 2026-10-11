export class IntelligentModelRouter {
  // Choisir le modèle optimal selon la tâche
  static selectModel(context: {
    taskType: 'simple' | 'complex' | 'reasoning' | 'creative';
    urgency: 'low' | 'medium' | 'high';
    budgetRemaining: number;
    preferredProvider?: string;
  }): ModelConfig {
    const { taskType, urgency, budgetRemaining, preferredProvider } = context;
    
    // Routage par budget
    if (budgetRemaining < 1000) {
      return this.getCheapModel(taskType);
    }
    
    // Routage par type de tâche
    switch (taskType) {
      case 'complex':
      case 'reasoning':
        return {
          provider: 'openai',
          model: 'gpt-4',
          maxTokens: 2000,
          temperature: 0.3,
        };
      
      case 'creative':
        return {
          provider: 'groq',
          model: 'mixtral-8x7b',
          maxTokens: 1500,
          temperature: 0.8,
        };
      
      case 'simple':
      default:
        // Utiliser le moins cher pour les tâches simples
        return {
          provider: 'groq',
          model: 'llama-3.1-8b',
          maxTokens: 500,
          temperature: 0.5,
        };
    }
  }
  
  // Fallback intelligent
  static async executeWithFallback(
    prompt: string,
    primaryModel: ModelConfig,
    fallbackModels: ModelConfig[]
  ): Promise<string> {
    const models = [primaryModel, ...fallbackModels];
    
    for (const model of models) {
      try {
        const response = await this.callModel(prompt, model);
        if (response && response.trim().length > 0) {
          return response;
        }
      } catch (error) {
        console.warn(`Model ${model.model} failed:`, error.message);
        continue;
      }
    }
    
    throw new Error('All models failed');
  }
  
  // Cache de réponses pour requêtes identiques
  static async getCachedOrGenerate(
    prompt: string,
    cacheKey: string,
    model: ModelConfig
  ): Promise<string> {
    const cached = await CacheManager.get(`llm:${cacheKey}`);
    if (cached) return cached;
    
    const response = await this.callModel(prompt, model);
    
    // Cache avec TTL basé sur la longueur de la réponse
    const ttl = response.length > 500 ? 3600 : 1800;
    await CacheManager.set(`llm:${cacheKey}`, response, ttl);
    
    return response;
  }
}
