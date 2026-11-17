import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationDto, MessageDto } from '../../src/core/api/contract';
import { ChatPane } from './components/ChatPane';
import { createSampleSource } from './data/sample';
import { STRINGS } from './i18n';

afterEach(cleanup);
const base: MessageDto = { id: 1, clientId: null, wamid: 'w1', direction: 'in', type: 'audio', text: null, hasLongBody: false, media: { mime: 'audio/ogg', size: 10, url: '/m/1' }, template: null, status: null, errorCode: null, at: Date.UTC(2026, 10, 12, 10, 0) };
const conversation = { id: 1, contact: { waId: '201001234567', name: 'منى', optedOut: false }, lastMessage: null, unread: 0, assigneeUserId: null, tags: [], windowEndsAt: null } as unknown as ConversationDto;
const pane = (m: MessageDto) => render(
  <ChatPane t={STRINGS.ar} lang="ar" now={Date.UTC(2026, 10, 12, 10, 5)} conversation={conversation} source={createSampleSource()} userNames={{}} currentOrder={null} messages={[m]} templates={[]}
    onSendText={() => undefined} onSendTemplate={() => undefined} onRetry={() => undefined} onBack={() => undefined} onShowOrders={() => undefined} />,
);

describe('voice notes in the merchant inbox', () => {
  it('shows the transcript under the voice note, marked as a transcript', () => {
    pane({ ...base, text: 'عايز اعرف سعر الورد', voice: 'transcribed' });
    expect(screen.getByText('عايز اعرف سعر الورد')).toBeTruthy();
    expect(screen.getByText(STRINGS.ar.voiceTranscript)).toBeTruthy();
  });
  it('says so when the voice note could not be transcribed', () => {
    pane({ ...base, voice: 'not_transcribed' });
    expect(screen.getByText(STRINGS.ar.voiceNotTranscribed)).toBeTruthy();
  });
  it('a plain audio message carries neither mark; both languages have the strings', () => {
    pane(base);
    expect(screen.queryByText(STRINGS.ar.voiceTranscript)).toBeNull();
    expect(screen.queryByText(STRINGS.ar.voiceNotTranscribed)).toBeNull();
    expect(STRINGS.en.voiceNotTranscribed).toBe('Voice note (not transcribed)');
  });
});
