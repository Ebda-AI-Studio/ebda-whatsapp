import { expect, it } from 'vitest';
import { conversationDto, realtimeEvent, sendMessageRequest } from '../src/core/api/contract';

const uuid = '0b6f1c7e-1d2a-4f3b-9c8d-7e6f5a4b3c2d';

it('accepts each send type and rejects an unknown one', () => {
  expect(sendMessageRequest.safeParse({ type: 'text', clientId: uuid, text: 'أهلاً' }).success).toBe(true);
  expect(sendMessageRequest.safeParse({ type: 'template', clientId: uuid, name: 'order_confirmation', language: 'ar' }).success).toBe(true);
  expect(sendMessageRequest.safeParse({ type: 'interactive', clientId: uuid, body: 'تأكيد؟', buttons: [{ id: 'yes', title: 'أيوه' }] }).success).toBe(true);
  expect(sendMessageRequest.safeParse({ type: 'sms', clientId: uuid, text: 'x' }).success).toBe(false);
});

it('rejects a button title over Meta\'s 20 characters', () => {
  expect(sendMessageRequest.safeParse({ type: 'interactive', clientId: uuid, body: 'b', buttons: [{ id: 'a', title: 'x'.repeat(21) }] }).success).toBe(false);
});

it('parses a realtime message event and a conversation', () => {
  const message = { id: 1, clientId: null, wamid: 'w', direction: 'in', type: 'text', text: 'hi', hasLongBody: false, media: null, template: null, status: null, errorCode: null, at: 1 };
  expect(realtimeEvent.safeParse({ type: 'message.created', seq: 1, conversationId: 1, message }).success).toBe(true);
  expect(conversationDto.safeParse({ id: 1, contact: { waId: '201001234567', name: null, optedOut: false }, lastMessage: null, unread: 0, assigneeUserId: null, tags: [], windowOpenUntil: null }).success).toBe(true);
});
