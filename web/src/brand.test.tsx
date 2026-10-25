import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

// Render the app as the neutral demo brand: no store product, no help site, its own mark and name.
vi.mock('@brand', async () => ({ BRAND: (await import('../brands/demo/brand')).BRAND }));

afterEach(cleanup);

it('a white-label brand shows its own mark and name, no store step and no help links', async () => {
  const { App } = await import('./App');
  const { createSampleSource } = await import('./data/sample');
  render(<App source={createSampleSource()} now={() => Date.UTC(2026, 9, 24, 17, 0)} />);
  expect(screen.getByAltText('Demo Company')).toBeTruthy();
  expect(document.title.startsWith('Inbox ·')).toBe(true);
  await act(async () => fireEvent.click(screen.getByRole('link', { name: 'رقم واتساب' })));
  const list = await screen.findByRole('list', { name: 'خطوات البداية' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(3);
  expect(within(list).queryAllByRole('link')).toHaveLength(0);
});
