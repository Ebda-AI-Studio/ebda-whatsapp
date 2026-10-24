import { z } from 'zod';

export const sendJobSchema = z.object({
  workspaceId: z.string().min(1),
  phoneNumberId: z.string().min(1),
  to: z.string().min(1),
  text: z.string().min(1).max(4096),
  idempotencyKey: z.string().min(1),
  inboundAt: z.number().optional(),
});
export type SendJob = z.infer<typeof sendJobSchema>;
