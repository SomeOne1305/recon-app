// Pure domain logic: zero I/O.
// checkEntry() is the single deterministic validation gate for every write,
// whether submitted manually from the UI or ingested from an AI / Telegram pipeline.

const TZ = 'America/New_York';
export const MAX_CENTS = 10_000_000; // 100,000.00 sanity cap per entry

// KINDS = what people / AI pipelines may create. SYSTEM_KINDS are created only by the app itself
// (escrow weekly payments, charges taken from escrow, charges upon leaving).
export const KINDS = ['reimbursement', 'chargeback'] as const;
export const SYSTEM_KINDS = ['escrow', 'escrow_charge', 'leaving_charge'] as const;
export const ALL_KINDS = [...KINDS, ...SYSTEM_KINDS] as const;
export const STATUSES = ['done', 'incomplete', 'issue'] as const;
export const SOURCES = ['manual', 'telegram', 'ai', 'system'] as const;

export type Kind = (typeof ALL_KINDS)[number];
export type Status = (typeof STATUSES)[number];
export type Source = (typeof SOURCES)[number];

export class UserError extends Error {
  constructor(
    message: string,
    public status = 400,
    public errors: string[] = [message]
  ) {
    super(message);
  }
}

export const clean = (v: unknown, max: number): string =>
  String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  (list as readonly string[]).includes(v as string);

/**
 * Parses plain numeric strings (e.g. "125.50", "1250", "1,250.00") into integer cents.
 * Strips optional leading currency symbol if an external AI pipeline includes one.
 */
export const toCents = (raw: string): number | null => {
  let s = String(raw ?? '').trim().replace(/^\$\s*/, '').replace(/\s+/g, '');
  if (!s) return null;
  // If comma is used as decimal separator (e.g. "1234,7" or "1234,70" with no period)
  if (/^\d+,\d{1,2}$/.test(s)) {
    s = s.replace(',', '.');
  }
  // Remove thousand-separator commas
  s = s.replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  const c = Number(w) * 100 + Number(f.padEnd(2, '0'));
  return Number.isSafeInteger(c) && c > 0 ? c : null;
};

export const normUnit = (v: unknown): string | null => {
  const t = String(v ?? '').trim();
  return /^\d{1,6}$/.test(t) ? String(parseInt(t, 10)) : null;
};

export const todayET = (d = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);

const isDate = (s: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

export const weekStartOf = (ymd: string): string => {
  const t = Date.parse(ymd + 'T00:00:00Z');
  return new Date(t - ((new Date(t).getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10);
};

export const weekEnd = (ws: string): string =>
  new Date(Date.parse(ws + 'T00:00:00Z') + 6 * 864e5).toISOString().slice(0, 10);

export const isMonday = (w: string): boolean => isDate(w) && weekStartOf(w) === w;

export const addWeeks = (ws: string, n: number): string =>
  new Date(Date.parse(ws + 'T00:00:00Z') + n * 7 * 864e5).toISOString().slice(0, 10);

/** Escrow split: equal weekly parts, any leftover cents go on the LAST week. n is 1-based. */
export const installmentAmount = (totalCents: number, weeks: number, n: number): number => {
  const base = Math.floor(totalCents / weeks);
  return n < weeks ? base : totalCents - base * (weeks - 1);
};

export const natCompare = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { numeric: true });

export const PARTIES = ['driver', 'owner'] as const;
export type Party = (typeof PARTIES)[number];

export interface EntryFields {
  unit: string;
  kind: Kind;
  amountCents: number;
  note: string;
  status: Status;
  statusNote: string;
  eventDate: string;
  weekStart: string;
  weekReason: string;
  source: Source;
  sourceRef: string;
  party: Party;
}

export interface Rules {
  activeUnits: Set<string> | null; // null = skip active-unit check (e.g., when editing existing entries)
  today: string;
  kinds?: readonly Kind[]; // defaults to KINDS (reimbursement / chargeback only)
  system?: boolean; // true only for entries built by the app itself (allows source 'system')
}

/**
 * Deterministic validation gate for structured JSON payloads.
 * Accepts `amount` ("125.50") or `amountCents` (12550).
 */
export function checkEntry(
  raw: any,
  rules: Rules
): { ok: true; value: EntryFields } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  const unit = normUnit(raw?.unit);
  if (!unit) {
    errors.push('Unit is required (digits only)');
  } else if (rules.activeUnits && !rules.activeUnits.has(unit)) {
    errors.push(`Unit ${unit} is not an active unit`);
  }

  if (!oneOf(rules.kinds ?? KINDS, raw?.kind)) {
    errors.push('Type must be reimbursement or chargeback');
  }

  const amountCents = Number.isSafeInteger(raw?.amountCents)
    ? raw.amountCents
    : toCents(String(raw?.amount ?? ''));
  if (!amountCents || amountCents < 1 || amountCents > MAX_CENTS) {
    errors.push('Amount must be between 0.01 and 100,000.00');
  }

  const status: Status = raw?.status ?? 'incomplete';
  if (!oneOf(STATUSES, status)) {
    errors.push('Status must be done, incomplete, or issue');
  }

  const statusNote = clean(raw?.statusNote, 200);
  if (status === 'issue' && !statusNote) {
    errors.push('Add a status note explaining the issue');
  }

  const eventDate = raw?.eventDate ? String(raw.eventDate) : '';
  if (eventDate && !isDate(eventDate)) {
    errors.push('Event date must be YYYY-MM-DD');
  }

  const weekStart = String(raw?.weekStart ?? weekStartOf(isDate(eventDate) ? eventDate : rules.today));
  if (!isMonday(weekStart)) {
    errors.push('Billing week must start on a Monday');
  }

  const weekReason = clean(raw?.weekReason, 200);
  if (isDate(eventDate) && isMonday(weekStart) && weekStart !== weekStartOf(eventDate) && !weekReason) {
    errors.push("Provide a reason when the billing week differs from the event date's week");
  }

  const source: Source = raw?.source ?? 'manual';
  if (!oneOf(SOURCES, source) || (source === 'system' && !rules.system)) {
    errors.push('Unknown source (must be manual, telegram, or ai)');
  }

  const rawParty = String(raw?.party ?? '').toLowerCase();
  const party: Party = rawParty === 'owner' ? 'owner' : 'driver';
  const ref = clean(raw?.refCode ?? raw?.sourceRef ?? '', 100);

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    value: {
      unit: unit!,
      kind: raw.kind,
      amountCents: amountCents!,
      note: clean(raw?.note, 200),
      status,
      statusNote,
      eventDate,
      weekStart,
      weekReason,
      source,
      sourceRef: ref,
      party,
    },
  };
}

export interface ParsedTelegram {
  moneyTransferCode?: string;
  reportRef?: string;
  loadNumber?: string;
  refCode?: string;
  amount?: string;
  amountCents?: number;
  issuedTo?: string;
  notes?: string;
  unit?: string;
  combinedNote: string;
  raw: string;
}

export function parseTelegramMessage(text: string): ParsedTelegram {
  const cleanText = text.replace(/^[•\-\*]\s*/gm, '').trim();

  // Extract Money Transfer code (EFS)
  const mtMatch = /(?:Money Transfer code|Transfer code|Money Code|EFS Code)\s*[:#]?\s*(\d+)/i.exec(cleanText);
  const moneyTransferCode = mtMatch ? mtMatch[1].trim() : undefined;

  // Extract Report Reference # (strictly for EFS / settlement reference, NOT Load #)
  const refMatch = /(?:Report Reference\s*#?|Reference\s*#?|Ref\s*#?)\s*[:\s]*([A-Za-z0-9\-]+)/i.exec(cleanText);
  const reportRef = refMatch ? refMatch[1].trim() : undefined;

  // Extract Load # separately
  const loadMatch = /(?:Load\s*#?|Load\s*:)\s*[:\s]*([A-Za-z0-9\-]+)/i.exec(cleanText);
  const loadNumber = loadMatch ? loadMatch[1].trim() : undefined;

  // The reference code for QM (Report Reference # is preferred, else Money Transfer code)
  const refCode = reportRef || moneyTransferCode || undefined;

  // Extract Amount (supports Amount, Total, Amt, with optional colon, $, or trailing $)
  const amtMatch =
    /(?:Amount|Total|Amt)\s*[:#]?\s*\$?\s*([0-9,]+(?:[.,][0-9]{1,2})?)\s*\$?|(?:^|\s)\$([0-9,]+(?:[.,][0-9]{1,2})?)|(?:^|\s)([0-9,]+(?:[.,][0-9]{1,2})?)\$/i.exec(cleanText);
  let amount = amtMatch ? (amtMatch[1] || amtMatch[2] || amtMatch[3]).trim() : undefined;
  if (amount && /^\d+,\d{1,2}$/.test(amount)) {
    amount = amount.replace(',', '.');
  } else if (amount) {
    amount = amount.replace(/,/g, '');
  }
  const amountCents = amount ? toCents(amount) ?? undefined : undefined;

  // Extract Issued To (handles city/state with commas, e.g. "Southern Tire Mart, AL")
  const issMatch = /Issued to\s*[:\s]*(.+?)(?=,\s*Notes\b|\s*Notes\b|\s*Reason\b|\s*$|\n)/i.exec(cleanText);
  const issuedTo = issMatch ? issMatch[1].trim() : undefined;

  // Extract Notes or Reason
  const notesMatch = /(?:Notes|Note|Reason|Description|For)\s*[:\s]*(.+?)(?=\s*(?:Load|Ref|Reference|Report|Amount|Unit|Target|\$)\b|\n|$)/i.exec(cleanText);
  const notes = notesMatch ? notesMatch[1].trim() : undefined;

  // Extract Unit number (e.g. "ALTUM 304 Byron", "Unit 304", "Truck 1002", "TR 124", or "#304")
  let unit: string | undefined;
  const unitMatch =
    /(?:Unit\s*#?\s*|ALTUM\s+|Truck\s*#?\s*|Trk\s*#?\s*|TR\s*#?\s*|TR-)(\d{1,6})/i.exec(cleanText) ||
    /(?:^|\s)#(\d{1,6})\b/.exec(cleanText) ||
    /^(\d{2,4})\s+[A-Za-z]/.exec(cleanText);
  if (unitMatch) {
    unit = unitMatch[1];
  }

  const parts = [
    issuedTo ? issuedTo : '',
    notes ? notes : '',
    loadNumber && !notes?.includes(loadNumber) ? `Load ${loadNumber}` : '',
    moneyTransferCode && reportRef ? `(EFS: ${moneyTransferCode})` : '',
  ].filter(Boolean);
  const combinedNote = parts.join(' - ') || (notes ? notes : cleanText.slice(0, 100));

  return {
    moneyTransferCode,
    reportRef,
    loadNumber,
    refCode,
    amount,
    amountCents,
    issuedTo,
    notes,
    unit,
    combinedNote,
    raw: text,
  };
}

export function splitInstallments(totalCents: number, weeks: number, startWeek: string) {
  if (weeks < 2) throw new UserError('Must divide into at least 2 weeks');
  const base = Math.floor(totalCents / weeks);
  const remainder = totalCents - base * weeks;
  const result = [];
  for (let i = 0; i < weeks; i++) {
    const cents = i === weeks - 1 ? base + remainder : base;
    result.push({
      n: i + 1,
      weeks,
      weekStart: addWeeks(startWeek, i),
      amountCents: cents,
    });
  }
  return result;
}
