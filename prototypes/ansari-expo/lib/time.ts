/**
 * Compact relative-time label ("now", "5m", "3h", "2d") for a conversation's
 * timestamp. Returns '' for a missing or unparseable value — apps/api omits
 * `updated_at` when the DB value is null, and the adapter fills it with '', so a
 * NaN guard keeps that by-design empty case from rendering as "NaNd".
 */
export function timeAgo(iso: string): string {
  if (!iso) return '';
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  const minutes = Math.floor((Date.now() - ms) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
