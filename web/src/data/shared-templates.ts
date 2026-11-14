import type { SharedRequestDto, TemplateDto } from '../../../src/core/api/contract';

/** The platform WABA's templates (super admin only): list the catalog, sync it from Meta, submit a new one. Marketing is not offered. */
export type SharedTemplateInput = {
  name: string;
  language: 'ar' | 'en';
  category: 'UTILITY' | 'AUTHENTICATION';
  components: { type: 'BODY'; text: string }[];
};
export interface SharedTemplatesApi {
  list(): Promise<TemplateDto[]>;
  sync(): Promise<{ upserted: number; removed: number }>;
  submit(input: SharedTemplateInput): Promise<{ status: string }>;
  /** What stores on the shared number asked the team to make (with the workspace that asked). */
  requests?(): Promise<(SharedRequestDto & { workspaceId: string })[]>;
}

/** Same rule the server applies at send time (WA-SHARED-NOCAMP-1), shown so the operator sees what stores can use. */
export const usableByStores = (t: Pick<TemplateDto, 'status' | 'category'>): boolean => t.status === 'APPROVED' && t.category !== 'MARKETING';
