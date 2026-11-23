import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { createSampleSource } from './data/sample';
import { STRINGS } from './i18n';

afterEach(cleanup);
const now = () => Date.UTC(2026, 9, 24, 17, 0);
const t = STRINGS.ar;

async function openForm(source: ReturnType<typeof createSampleSource>) {
  render(<App source={source} now={now} />);
  await act(async () => fireEvent.click(screen.getByRole('link', { name: 'الحملات' })));
  await screen.findByRole('heading', { name: 'الحملات' });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'حملة جديدة' })));
}

describe('campaigns on the shared number (A18, rule WA-SHARED-NOCAMP-1)', () => {
  it('a shared-number workspace sees why campaigns are off, with the connect link, and no submit', async () => {
    const source = createSampleSource();
    source.numbers!.list = async () => [];
    await source.numbers!.shared!.join('Sample Shop');
    await openForm(source);
    const note = await screen.findByRole('note', { name: t.campSharedTitle });
    expect(note.textContent).toContain(t.campSharedBody);
    expect(screen.queryByRole('button', { name: t.reviewCta })).toBeNull();
    expect(screen.queryByLabelText(t.campaignName)).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: t.tplSharedGoNumbers })));
    await screen.findByRole('heading', { name: t.numbersTitle });
  });

  it('a workspace with its own number sees the normal form and no notice', async () => {
    await openForm(createSampleSource());
    expect(screen.getByLabelText(t.campaignName)).toBeTruthy();
    expect(screen.getByRole('button', { name: t.reviewCta })).toBeTruthy();
    expect(screen.queryByRole('note', { name: t.campSharedTitle })).toBeNull();
  });
});
