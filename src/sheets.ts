// Storage layer: Google Sheets.
// Entries are append-only versioned rows; the Node.js server is the sole writer.
try {
  process.loadEnvFile?.('.env');
} catch {}

import { google } from 'googleapis';
import { UserError, natCompare, type Kind, type Status, type Source } from './domain.js';

export interface Entry {
  id: string;
  version: number;
  savedAt: string;
  savedBy: string;
  weekStart: string;
  eventDate: string;
  unit: string;
  kind: Kind;
  amountCents: number;
  note: string;
  status: Status;
  statusNote: string;
  source: Source;
  sourceRef: string;
  weekReason: string;
  voided: boolean;
  voidReason: string;
  createdAt: string;
  createdBy: string;
  party: 'driver' | 'owner';
}

export interface Unit {
  unit: string;
  driver: string;
  owner?: string;
  createdAt: string;
}

export interface Archived extends Unit {
  terminatedAt: string;
  terminatedBy: string;
  reason: string;
  owner?: string;
}

/** One escrow plan per unit at a time. Append-only versioned rows, latest version wins (same pattern as entries). */
export interface Plan {
  id: string;
  version: number;
  savedAt: string;
  savedBy: string;
  unit: string;
  totalCents: number;
  weeks: number;
  startWeek: string;
  note: string;
  status: 'active' | 'cancelled' | 'closed';
  statusNote: string;
}

const HEADERS = {
  units: ['unit', 'driver', 'created_at', 'owner'],
  archive_units: ['unit', 'driver', 'created_at', 'terminated_at', 'terminated_by', 'reason', 'owner'],
  entries: [
    'id',
    'version',
    'saved_at',
    'saved_by',
    'week_start',
    'event_date',
    'unit',
    'kind',
    'amount_cents',
    'note',
    'status',
    'status_note',
    'source',
    'source_ref',
    'week_reason',
    'voided',
    'void_reason',
    'created_at',
    'created_by',
    'party',
  ],
  escrow_plans: [
    'plan_id',
    'version',
    'saved_at',
    'saved_by',
    'unit',
    'total_cents',
    'weeks',
    'start_week',
    'note',
    'status',
    'status_note',
  ],
};

if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON in .env');
}
if (!process.env.SHEET_ID) {
  throw new Error('Missing SHEET_ID in .env');
}

const api = google.sheets({
  version: 'v4',
  auth: new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  }),
});

const spreadsheetId = process.env.SHEET_ID;
const str = (v: unknown) => String(v ?? '');

const read = async (tab: string) =>
  (
    await api.spreadsheets.values.get({
      spreadsheetId,
      range: `${tab}!A2:Z`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    })
  ).data.values ?? [];

let state = {
  latest: new Map<string, Entry>(),
  versions: new Map<string, Entry[]>(),
  units: [] as Unit[],
  archived: [] as Archived[],
  plans: new Map<string, Plan>(),
};

export const snapshot = () => state;

export async function refresh() {
  const [u, a, e, p] = await Promise.all([
    read('units'),
    read('archive_units'),
    read('entries'),
    read('escrow_plans'),
  ]);

  const plans = new Map<string, Plan>();
  for (const r of p.filter((r) => str(r[0]) !== '')) {
    const row: Plan = {
      id: str(r[0]),
      version: Number(r[1]),
      savedAt: str(r[2]),
      savedBy: str(r[3]),
      unit: str(r[4]).trim(),
      totalCents: Number(r[5]),
      weeks: Number(r[6]),
      startWeek: str(r[7]),
      note: str(r[8]),
      status: (str(r[9]) || 'active') as Plan['status'],
      statusNote: str(r[10]),
    };
    if (!Number.isSafeInteger(row.totalCents) || !Number.isInteger(row.weeks) || !Number.isInteger(row.version)) {
      throw new Error(`Corrupt row for escrow plan ${r[0]}`);
    }
    const prev = plans.get(row.id);
    if (!prev || row.version > prev.version) plans.set(row.id, row);
  }

  const archived = a
    .filter((r) => str(r[0]) !== '')
    .map((r) => ({
      unit: str(r[0]).trim(),
      driver: str(r[1]),
      createdAt: str(r[2]),
      terminatedAt: str(r[3]),
      terminatedBy: str(r[4]),
      reason: str(r[5]),
      owner: str(r[6] ?? '').trim(),
    }));

  const gone = new Set(archived.map((x) => x.unit)); // archive wins if a crash left a unit in both tabs
  const versions = new Map<string, Entry[]>();

  for (const r of e.filter((r) => str(r[0]) !== '')) {
    const amountCents = Number(r[8]);
    const version = Number(r[1]);
    if (!Number.isSafeInteger(amountCents) || !Number.isInteger(version)) {
      throw new Error(`Corrupt row for entry ${r[0]}`);
    }
    const row: Entry = {
      id: str(r[0]),
      version,
      savedAt: str(r[2]),
      savedBy: str(r[3]),
      weekStart: str(r[4]),
      eventDate: str(r[5]),
      unit: str(r[6]).trim(),
      kind: r[7] as Kind,
      amountCents,
      note: str(r[9]),
      status: (str(r[10]) || 'incomplete') as Status,
      statusNote: str(r[11]),
      source: (str(r[12]) || 'manual') as Source,
      sourceRef: str(r[13]),
      weekReason: str(r[14]),
      voided: r[15] === true || r[15] === 'TRUE',
      voidReason: str(r[16]),
      createdAt: str(r[17]),
      createdBy: str(r[18]),
      party: (str(r[19]).toLowerCase() === 'owner' ? 'owner' : 'driver'),
    };
    versions.set(row.id, [...(versions.get(row.id) ?? []), row]);
  }

  const latest = new Map<string, Entry>();
  for (const [id, vs] of versions) {
    vs.sort((x, y) => x.version - y.version);
    latest.set(id, vs[vs.length - 1]);
  }

  state = {
    latest,
    versions,
    plans,
    archived,
    units: u
      .filter((r) => str(r[0]) !== '' && !gone.has(str(r[0]).trim()))
      .map((r) => ({
        unit: str(r[0]).trim(),
        driver: str(r[1]),
        createdAt: str(r[2]),
        owner: str(r[3] ?? '').trim(),
      })),
  };
}

// Serialized write queue prevents concurrent race conditions on Google Sheets
let tail: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = tail.then(fn);
  tail = run.catch(() => {});
  return run;
};

const append = (tab: string, values: unknown[][]) =>
  api.spreadsheets.values.append({
    spreadsheetId,
    range: `${tab}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });

const settle = () =>
  refresh().catch((err) => console.error('refresh after write failed (next poll retries)', err));

const toRow = (e: Entry) => [
  e.id,
  e.version,
  e.savedAt,
  e.savedBy,
  e.weekStart,
  e.eventDate,
  e.unit,
  e.kind,
  e.amountCents,
  e.note,
  e.status,
  e.statusNote,
  e.source,
  e.sourceRef,
  e.weekReason,
  e.voided,
  e.voidReason,
  e.createdAt,
  e.createdBy,
  e.party || 'driver',
];

export const createEntries = (rows: Entry[]) =>
  serial(async () => {
    await append('entries', rows.map(toRow));
    await settle();
  });

/** Edits and voids append a NEW versioned row. Optimistic locking rejects stale versions. */
export const saveVersion = (next: Entry, expectedVersion: number) =>
  serial(async () => {
    const cur = state.latest.get(next.id);
    if (!cur) throw new UserError('Entry not found', 404);
    if (cur.version !== expectedVersion) {
      throw new UserError('Someone else modified this entry. Refresh and try again.', 409);
    }
    await append('entries', [toRow(next)]);
    await settle();
  });

const applyUnits = async (r: { units: Unit[]; archived?: Archived }) => {
  if (r.archived) {
    const a = r.archived;
    await append('archive_units', [
      [a.unit, a.driver, a.createdAt, a.terminatedAt, a.terminatedBy, a.reason, a.owner || ''],
    ]);
  }
  const rows = [...r.units]
    .sort((a, b) => natCompare(a.unit, b.unit))
    .map((u) => [u.unit, u.driver, u.createdAt, u.owner || '']);
  await api.spreadsheets.values.clear({ spreadsheetId, range: 'units!A2:D' });
  if (rows.length) {
    await api.spreadsheets.values.update({
      spreadsheetId,
      range: 'units!A2',
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });
  }
};

/** Updates active units and optionally appends a terminated unit record to archive_units. */
export const changeUnits = (
  fn: (units: Unit[], archived: Archived[]) => { units: Unit[]; archived?: Archived }
) =>
  serial(async () => {
    await applyUnits(fn(state.units, state.archived));
    await settle();
  });

const planRow = (p: Plan) => [
  p.id,
  p.version,
  p.savedAt,
  p.savedBy,
  p.unit,
  p.totalCents,
  p.weeks,
  p.startWeek,
  p.note,
  p.status,
  p.statusNote,
];

export interface Intent {
  entries?: Entry[]; // new rows to append (new entries AND new versions of existing ones)
  expect?: Array<[id: string, version: number]>; // optimistic-lock checks, verified before anything is written
  plans?: Plan[]; // new plan versions to append
  plansFirst?: boolean; // write plans before entries (used when a plan is created together with its first installment)
  units?: (units: Unit[], archived: Archived[]) => { units: Unit[]; archived?: Archived };
}

/**
 * Runs `fn` inside the write queue against the latest snapshot, then writes whatever it asks for.
 * Everything that must be decided from current state (escrow roll-over, termination, ...) goes through
 * here so two requests can never both decide to create the same row.
 * Return `{ result }` alone to write nothing.
 */
export const locked = <T>(
  fn: (s: typeof state) => { result: T; intent?: Intent },
  opts: { fresh?: boolean } = {}
): Promise<T> =>
  serial(async () => {
    if (opts.fresh) await refresh();
    const { result, intent } = fn(state);
    if (!intent) return result;
    for (const [id, v] of intent.expect ?? []) {
      const cur = state.latest.get(id);
      if (!cur) throw new UserError('Entry not found', 404);
      if (cur.version !== v) throw new UserError('Someone else modified this entry. Refresh and try again.', 409);
    }
    const writeEntries = async () => {
      if (intent.entries?.length) await append('entries', intent.entries.map(toRow));
    };
    const writePlans = async () => {
      if (intent.plans?.length) await append('escrow_plans', intent.plans.map(planRow));
    };
    if (intent.plansFirst) {
      await writePlans();
      await writeEntries();
    } else {
      await writeEntries();
      await writePlans();
    }
    if (intent.units) await applyUnits(intent.units(state.units, state.archived));
    await settle();
    return result;
  });

/** Creates any missing tab (e.g. escrow_plans) so the owner does not have to add it by hand. */
async function ensureTabs() {
  const meta = await api.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  const have = new Set((meta.data.sheets ?? []).map((x) => x.properties?.title));
  const missing = Object.keys(HEADERS).filter((t) => !have.has(t));
  if (missing.length) {
    await api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) },
    });
    console.log(`Created missing sheet tab(s): ${missing.join(', ')}`);
  }
}

export async function ensureHeaders() {
  await ensureTabs();
  for (const [tab, cols] of Object.entries(HEADERS)) {
    const got = (
      await api.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A1:Z1` })
    ).data.values?.[0] ?? [];
    if (!got.length) {
      await api.spreadsheets.values.update({
        spreadsheetId,
        range: `${tab}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [cols] },
      });
    } else {
      // Check if existing headers match canonical headers
      const mismatch = cols.some((c, i) => got[i] !== c);
      if (mismatch) {
        // Self-heal: clear row 1 and write canonical headers, keeping all data rows 2+ safe
        await api.spreadsheets.values.clear({ spreadsheetId, range: `${tab}!1:1` });
        await api.spreadsheets.values.update({
          spreadsheetId,
          range: `${tab}!A1`,
          valueInputOption: 'RAW',
          requestBody: { values: [cols] },
        });
        console.log(`Self-healed header row for tab "${tab}" to canonical schema.`);
      } else if (got.length < cols.length) {
        await api.spreadsheets.values.update({
          spreadsheetId,
          range: `${tab}!A1`,
          valueInputOption: 'RAW',
          requestBody: { values: [cols] },
        });
        console.log(`Updated header row for tab "${tab}" with new columns: ${cols.slice(got.length).join(', ')}`);
      }
    }
  }
}
