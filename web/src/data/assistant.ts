import type { AssistantActResponse, AssistantApproval, AssistantConversationResponse, AssistantPreviewCard, AssistantSegment, AssistantTurnResponse } from '../../../src/core/api/contract';
import type { View } from '../components/Rail';

/** The assistant's client contract: the live source calls the Worker, the sample source answers from a script. */
export interface AssistantApi {
  turn(body: { conversationId: string; text: string; locale: 'ar' | 'en' }): Promise<AssistantTurnResponse>;
  conversation(conversationId: string): Promise<AssistantConversationResponse['items']>;
  feedback(turnId: string, thumb: 'up' | 'down'): Promise<void>;
  /** The merchant's press on a preview card: the only way a change happens. */
  apply(previewId: string): Promise<AssistantActResponse>;
  undo(appliedId: string): Promise<AssistantActResponse>;
  /** The press on a confirm card's own button, with the one-time token that came with the turn. */
  confirm(approvalId: string, token: string): Promise<AssistantActResponse>;
  reject(approvalId: string): Promise<{ status: string }>;
}

const VIEWS: readonly View[] = ['inbox', 'campaigns', 'templates', 'contacts', 'agent', 'bot', 'numbers', 'wallet', 'team', 'operator'];
/** A registry screen path ('/wallet') as a screen of this app, or null when this build has no such screen (the label is then plain text, never a dead link). */
export function viewForPath(appPath: string): View | null {
  const v = appPath.replace(/^\//, '');
  return (VIEWS as readonly string[]).includes(v) ? (v as View) : null;
}

/** Only an https address ever becomes a link, with no credentials: a reply the server let through is still never trusted to carry a script or data address. */
export function safeHref(href: string): string | null {
  try {
    const u = new URL(href);
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

export type ChatItem =
  | { id: string; role: 'merchant'; text: string }
  | { id: string; role: 'assistant'; segments: AssistantSegment[]; turnId?: string; status?: AssistantTurnResponse['status']; previews?: AssistantPreviewCard[]; approvals?: AssistantApproval[] };

const PREFIX = 'assistant.conversation.';
const KEY = (storeId: string, userId: string) => `${PREFIX}${storeId}.${userId}`;
/** The conversation id survives a reload, per STORE AND PERSON (a shared shop computer: the next person to sign in never inherits it); storage can throw (private window), then it is simply a new one. */
export function conversationIdFor(storeId: string, userId: string): string {
  try {
    const have = sessionStorage.getItem(KEY(storeId, userId));
    if (have) return have;
    const fresh = crypto.randomUUID();
    sessionStorage.setItem(KEY(storeId, userId), fresh);
    return fresh;
  } catch {
    return crypto.randomUUID();
  }
}
export function forgetConversation(storeId: string, userId: string): void {
  try { sessionStorage.removeItem(KEY(storeId, userId)); } catch { /* nothing to forget */ }
}
/** Sign-out: every conversation id of this browser tab goes, whoever it belonged to. */
export function clearAssistantConversations(): void {
  try {
    for (const k of Object.keys(sessionStorage)) if (k.startsWith(PREFIX)) sessionStorage.removeItem(k);
  } catch { /* storage unavailable: nothing was kept */ }
}
