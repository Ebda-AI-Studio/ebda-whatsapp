import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchBox, optionId, type SearchStatus } from './components/SearchBox';
import { STRINGS, type Lang } from './i18n';

afterEach(cleanup);

function Harness({ lang = 'en', status = 'done', count = 3, query = 'a', onPick = () => {}, onQuery }: {
  lang?: Lang; status?: SearchStatus; count?: number; query?: string; onPick?: (i: number) => void; onQuery?: (q: string) => void;
}) {
  const [active, setActive] = useState(-1);
  const [q, setQ] = useState(query);
  return (
    <SearchBox t={STRINGS[lang]} lang={lang} label="Search" query={q} onQuery={(v) => { setQ(v); onQuery?.(v); }} status={status} count={count}
      listId="results" activeIndex={active} onActiveIndex={setActive} onPick={onPick} />
  );
}
const box = () => screen.getByRole('combobox');

describe('SearchBox ARIA', () => {
  it('is a labelled combobox with list autocomplete, controlling the list', () => {
    render(<Harness />);
    expect(box().getAttribute('aria-autocomplete')).toBe('list');
    expect(box().getAttribute('aria-controls')).toBe('results');
    expect(box().getAttribute('aria-expanded')).toBe('true');
    expect(box().getAttribute('type')).toBe('search');
    expect(box().getAttribute('dir')).toBe('auto');
    expect(screen.getByLabelText('Search')).toBe(box());
  });
  it('is collapsed when the query is empty or there are no results', () => {
    render(<Harness query="" count={0} status="idle" />);
    expect(box().getAttribute('aria-expanded')).toBe('false');
    expect(box().getAttribute('aria-activedescendant')).toBeNull();
  });
});

describe('SearchBox keyboard', () => {
  it('ArrowDown/ArrowUp move the active option with wrap, aria-activedescendant follows', () => {
    render(<Harness />);
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(box().getAttribute('aria-activedescendant')).toBe(optionId('results', 0));
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(box().getAttribute('aria-activedescendant')).toBe(optionId('results', 2));
    fireEvent.keyDown(box(), { key: 'ArrowDown' }); // wraps
    expect(box().getAttribute('aria-activedescendant')).toBe(optionId('results', 0));
    fireEvent.keyDown(box(), { key: 'ArrowUp' }); // wraps back
    expect(box().getAttribute('aria-activedescendant')).toBe(optionId('results', 2));
  });
  it('ArrowUp from nothing goes to the last option; Home and End jump', () => {
    render(<Harness />);
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().getAttribute('aria-activedescendant')).toBe(optionId('results', 2));
    fireEvent.keyDown(box(), { key: 'Home' });
    expect(box().getAttribute('aria-activedescendant')).toBe(optionId('results', 0));
    fireEvent.keyDown(box(), { key: 'End' });
    expect(box().getAttribute('aria-activedescendant')).toBe(optionId('results', 2));
  });
  it('Enter picks the active option; with none active it does nothing', () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith(1);
  });
  it('Escape clears the query, closes the list and drops the active option', () => {
    const onQuery = vi.fn();
    render(<Harness onQuery={onQuery} />);
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(onQuery).toHaveBeenCalledWith('');
    expect((box() as HTMLInputElement).value).toBe('');
    expect(box().getAttribute('aria-expanded')).toBe('false');
    expect(box().getAttribute('aria-activedescendant')).toBeNull();
  });
  it('typing resets the active option', () => {
    render(<Harness />);
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.change(box(), { target: { value: 'ab' } });
    expect(box().getAttribute('aria-activedescendant')).toBeNull();
  });
  it('arrow keys do nothing when there are no results', () => {
    render(<Harness count={0} />);
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(box().getAttribute('aria-activedescendant')).toBeNull();
  });
});

describe('SearchBox live status', () => {
  const live = () => document.querySelector('[aria-live="polite"]')!;
  it('is polite and empty while idle', () => {
    render(<Harness status="idle" query="" count={0} />);
    expect(live().getAttribute('aria-live')).toBe('polite');
    expect(live().textContent).toBe('');
  });
  it('English: searching, no results for the query, result count', () => {
    const { rerender } = render(<SearchBox t={STRINGS.en} lang="en" label="Search" query="zed" onQuery={() => {}} status="loading" count={0} listId="r" activeIndex={-1} onActiveIndex={() => {}} onPick={() => {}} />);
    expect(live().textContent).toBe('Searching…');
    rerender(<SearchBox t={STRINGS.en} lang="en" label="Search" query="zed" onQuery={() => {}} status="done" count={0} listId="r" activeIndex={-1} onActiveIndex={() => {}} onPick={() => {}} />);
    expect(live().textContent).toBe('No results for “zed”');
    rerender(<SearchBox t={STRINGS.en} lang="en" label="Search" query="zed" onQuery={() => {}} status="done" count={3} listId="r" activeIndex={-1} onActiveIndex={() => {}} onPick={() => {}} />);
    expect(live().textContent).toBe('3 results');
    rerender(<SearchBox t={STRINGS.en} lang="en" label="Search" query="zed" onQuery={() => {}} status="done" count={1} listId="r" activeIndex={-1} onActiveIndex={() => {}} onPick={() => {}} />);
    expect(live().textContent).toBe('1 result');
  });
  it('Arabic (Egyptian): بندوّر، مفيش نتايج لـ، لقينا 3 نتايج', () => {
    const { rerender } = render(<SearchBox t={STRINGS.ar} lang="ar" label="بحث" query="زيد" onQuery={() => {}} status="loading" count={0} listId="r" activeIndex={-1} onActiveIndex={() => {}} onPick={() => {}} />);
    expect(live().textContent).toBe('بندوّر…');
    rerender(<SearchBox t={STRINGS.ar} lang="ar" label="بحث" query="زيد" onQuery={() => {}} status="done" count={0} listId="r" activeIndex={-1} onActiveIndex={() => {}} onPick={() => {}} />);
    expect(live().textContent).toBe('مفيش نتايج لـ «زيد»');
    rerender(<SearchBox t={STRINGS.ar} lang="ar" label="بحث" query="زيد" onQuery={() => {}} status="done" count={3} listId="r" activeIndex={-1} onActiveIndex={() => {}} onPick={() => {}} />);
    expect(live().textContent).toBe('لقينا 3 نتايج');
  });
  it('an error says so instead of "no results"', () => {
    render(<Harness status="error" count={0} />);
    expect(live().textContent).toBe(STRINGS.en.searchFailed);
  });
});
