import {z} from 'zod';
import {VIEW_MARKS, VIEW_REPORT_REASONS} from '../view/diagnostic-marks.js';

// The one report shape a diagnostic card may send to the beacon (#335). Every field is an enumerated value, a
// bounded token or a number; unknown keys and free text (error messages included) are dropped before logging. The
// shape limits what is logged; it does not make a report authentic. Anyone who can reach the route can send one.

export const MAX_VIEW_REPORT_BYTES = 8_192;
/** Reports accepted per instance per minute; more are refused with 429 and noted once. */
export const VIEW_REPORTS_PER_MINUTE = 120;

const TOKEN = /^[A-Za-z0-9._+-]{1,80}$/;
const token = z.string().regex(TOKEN);
const lenientToken = z.string().max(200).transform(value => /^[A-Za-z0-9 ._+-]{1,80}$/.test(value) ? value : 'other');

const reportSchema = z.object({
  v: z.literal(1),
  id: z.string().regex(/^[a-z0-9]{8,32}$/),
  release: token,
  reason: z.enum(VIEW_REPORT_REASONS),
  visibility: z.enum(['visible', 'hidden']).optional(),
  host: lenientToken.optional(),
  failure: z.enum(['policy', 'connect', 'ready', 'application', 'disposed']).optional(),
  marks: z.record(z.string(), z.number().finite().nonnegative().max(3_600_000)),
  errors: z.array(z.object({
    type: z.enum(['error', 'rejection', 'csp', 'callback']),
    name: lenientToken.optional(),
    directive: lenientToken.optional(),
    blocked: lenientToken.optional(),
    phase: lenientToken.optional(),
  })).max(20).optional(),
});

export type ViewReport = {
  view: string;
  viewRelease: string;
  reason: string;
  visibility?: string;
  host?: string;
  failure?: string;
  marks: Record<string, number>;
  errors: Record<string, string>[];
};

/** The report's loggable fields, or `undefined` when the body is not exactly the report shape. */
export function parseViewReport(body: string): ViewReport | undefined {
  let json: unknown;
  try { json = JSON.parse(body); } catch { return undefined; }
  const parsed = reportSchema.safeParse(json);
  if (!parsed.success) return undefined;
  const report = parsed.data;
  const marks: Record<string, number> = {};
  for (const name of VIEW_MARKS) if (report.marks[name] !== undefined) marks[name] = Math.round(report.marks[name]);
  return {
    view: report.id,
    viewRelease: report.release,
    reason: report.reason,
    ...(report.visibility === undefined ? {} : {visibility: report.visibility}),
    ...(report.host === undefined ? {} : {host: report.host}),
    ...(report.failure === undefined ? {} : {failure: report.failure}),
    marks,
    errors: (report.errors ?? []).map(error => Object.fromEntries(Object.entries(error).filter(([, value]) => value !== undefined)) as Record<string, string>),
  };
}

/** The sending document's origin as a host name only: which host sandbox the card ran in. */
export function originHost(origin: string | null): string {
  if (origin === null) return 'none';
  if (origin === 'null') return 'null';
  try { return new URL(origin).hostname || 'other'; } catch { return 'other'; }
}
