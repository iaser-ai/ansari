/**
 * The rail's list heading. While the search field holds anything, the
 * list under it is a filtered view, not the reader's questions — so the
 * heading says so, on the same condition the empty-state line already
 * switches on.
 */
export function railSectionLabel(query: string): string {
  return query.trim() ? 'Search results' : 'Questions';
}
