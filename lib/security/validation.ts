import { z } from 'zod';

// Schéma de validation pour création d'agent
export const createAgentSchema = z.object({
  name: z.string()
    .min(2, "Le nom doit avoir au moins 2 caractères")
    .max(100, "Le nom ne peut pas dépasser 100 caractères")
    .regex(/^[a-zA-Z0-9\s\-_]+$/, "Caractères spéciaux non autorisés"),
  description: z.string().max(1000).optional(),
  type: z.enum(['assistant', 'analyst', 'custom']),
  memoryEnabled: z.boolean().default(true),
  maxTokens: z.number().int().min(100).max(10000).default(2000),
  skills: z.array(z.string().uuid()).max(20).default([]),
});

// Middleware de validation
export function validateInput<T>(schema: z.ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: result.error.issues,
        traceId: req.headers['x-trace-id'],
      });
    }
    req.validatedBody = result.data;
    next();
  };
}
