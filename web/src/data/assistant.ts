import type { AssistantConversationResponse, AssistantSegment, AssistantTurnResponse } from '../../../src/core/api/contract';
import type { View } from '../components/Rail';

/** The assistant's client contract: the live source calls the Worker, the sample source answers from a script. */
export interface AssistantApi {
  turn(body: { conversationId: string; text: string; locale: 'ar' | 'en' }): Promise<AssistantTurnResponse>;
  conversation(conversationId: string): Promise<AssistantConversationResponse['items']>;
  feedback(turnId: string, thumb: 'up' | 'down'): Promise<void>;
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
  | { id: string; role: 'assistant'; segments: AssistantSegment[]; turnId?: string; status?: AssistantTurnResponse['status'] };

const KEY = (storeId: string) => `assistant.conversation.${storeId}`;
/** The conversation id survives a reload (per store, per browser tab session); storage can throw (private window), then it is simply a new one. */
export function conversationIdFor(storeId: string): string {
  try {
    const have = sessionStorage.getItem(KEY(storeId));
    if (have) return have;
    const fresh = crypto.randomUUID();
    sessionStorage.setItem(KEY(storeId), fresh);
    return fresh;
  } catch {
    return crypto.randomUUID();
  }
}
export function forgetConversation(storeId: string): void {
  try { sessionStorage.removeItem(KEY(storeId)); } catch { /* nothing to forget */ }
}
