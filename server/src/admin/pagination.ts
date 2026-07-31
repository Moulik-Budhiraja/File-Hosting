// Cursor-based pager. The server only exposes forward cursors, so "prev" is a
// client-side history of the cursors used to reach the current page.

export interface PagerState {
  history: (string | undefined)[];
  page: number;
  cursor: string | undefined;
}

function fromHistory(history: (string | undefined)[]): PagerState {
  return {
    history,
    page: history.length,
    cursor: history[history.length - 1],
  };
}

export function initialPager(): PagerState {
  return fromHistory([undefined]);
}

export function resetPager(): PagerState {
  return initialPager();
}

export function advancePager(
  pager: PagerState,
  nextCursor: string,
): PagerState {
  return fromHistory([...pager.history, nextCursor]);
}

export function retreatPager(pager: PagerState): PagerState {
  if (pager.history.length <= 1) return pager;
  return fromHistory(pager.history.slice(0, -1));
}

export function pagerLabel(
  pager: PagerState,
  limit: number,
  rowCount: number,
  hasMore: boolean,
): string {
  if (rowCount === 0) return "no rows";
  const start = (pager.page - 1) * limit + 1;
  const end = start + rowCount - 1;
  const range = `rows ${start}–${end}`;
  return hasMore ? `${range} · more available` : range;
}
