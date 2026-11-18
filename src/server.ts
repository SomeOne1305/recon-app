// Load .env locally if present (on Render/production, environment variables are injected via process.env)
try {
  process.loadEnvFile?.('.env');
} catch {}

import express, { type Request, type Response } from 'express';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  checkEntry,
  clean,
  normUnit,
  weekStartOf,
  weekEnd,
  todayET,
  natCompare,
  addWeeks,
  ALL_KINDS,
  SYSTEM_KINDS,
  UserError,
  splitInstallments,
  parseTelegramMessage,
  toCents,
} from './domain.js';
import {
  ensureHeaders,
  refresh,
  snapshot,
  createEntries,
  saveVersion,
  changeUnits,
  locked,
  type Entry,
  type Plan,
} from './sheets.js';
import {
  registerSlice3,
  rollEscrow,
  terminateUnit,
  zones,
  escrowBrief,
  assertEscrowRoom,
  buildRoll,
} from './slice3.js';
import { startTelegramListener, catchUpMissedMessages } from './telegram.js';

// ───────── Auth: embedded login form + signed HttpOnly session cookie ─────────
const users = (process.env.APP_USERS ?? '')
  .split(',')
  .filter(Boolean)
  .map((s) => {
    const i = s.indexOf(':');
    return { u: s.slice(0, i).trim(), p: s.slice(i + 1) };
  });

if (!users.length || users.length > 3) {
  throw new Error('Set APP_USERS="name:password,..." (1 to 3 users)');
}

const SECRET = process.env.SESSION_SECRET ?? '';
if (SECRET.length < 32) {
  throw new Error('Set SESSION_SECRET in .env to a random string of 32+ characters');
}

const AI_INGEST_KEY = process.env.AI_INGEST_KEY ?? '';

const eq = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const sign = (v: string) => createHmac('sha256', SECRET).update(v).digest('base64url');

const makeToken = (user: string) => {
  const b = Buffer.from(`${user}|${Date.now() + 12 * 3600_000}`).toString('base64url');
  return `${b}.${sign(b)}`;
};

const readToken = (header = ''): string | null => {
  const t = /(?:^|;\s*)session=([^;]+)/.exec(header)?.[1];
  if (!t) return null;
  const [b, s] = t.split('.');
  if (!b || !s || !eq(s, sign(b))) return null;
  const [user, exp] = Buffer.from(b, 'base64url').toString().split('|');
  return Number(exp) > Date.now() ? user : null;
};

const cookie = (v: string, maxAge: number) =>
  `session=${v}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${
    process.env.NODE_ENV === 'production' ? '; Secure' : ''
  }`;

type H = (req: Request, res: Response) => Promise<unknown> | unknown;
const h = (fn: H) => async (req: Request, res: Response) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (e instanceof UserError) {
      return void res.status(e.status).json({ error: e.message, errors: e.errors });
    }
    console.error(e);
    res.status(502).json({ error: 'Could not reach Google Sheets. Nothing was changed.' });
  }
};

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use(express.static('public'));

// ───────── Login / Logout ─────────
const tries = new Map<string, { n: number; until: number }>();

app.post(
  '/api/login',
  h((req, res) => {
    const ip = req.ip ?? '';
    const t = tries.get(ip);
    const live = t && t.until > Date.now() ? t : undefined;
    if (live && live.n >= 8) {
      throw new UserError('Too many login attempts. Please wait a few minutes.', 429);
    }
    const hit = users.find(
      (x) => eq(x.u, String(req.body.user ?? '').trim()) && eq(x.p, String(req.body.password ?? ''))
    );
    if (!hit) {
      tries.set(ip, { n: (live?.n ?? 0) + 1, until: Date.now() + 5 * 60_000 });
      throw new UserError('Invalid username or password', 401);
    }
    tries.delete(ip);
    res.setHeader('Set-Cookie', cookie(makeToken(hit.u), 12 * 3600)).json({ user: hit.u });
  })
);

app.post('/api/logout', (_q, res) => {
  res.setHeader('Set-Cookie', cookie('', 0)).json({ ok: true });
});

// ───────── AI / Telegram Ingestion Seam (Optional API Key or Session Auth) ─────────
// External Groq/Telegram workers can POST structured JSON payloads directly to /api/ingest/entries
// using header `x-api-key: <AI_INGEST_KEY>`, passing through the exact same deterministic checkEntry() gate.
app.post(
  '/api/ingest/entries',
  h(async (req, res) => {
    const apiKey = String(req.headers['x-api-key'] ?? '');
    const sessionUser = readToken(req.headers.cookie);

    if (!sessionUser) {
      if (!AI_INGEST_KEY || !apiKey || !eq(apiKey, AI_INGEST_KEY)) {
        throw new UserError('Unauthorized ingestion request', 401);
      }
    }

    const actor = sessionUser ?? 'ai-pipeline';
    const input: unknown[] = Array.isArray(req.body.entries) ? req.body.entries : [];
    if (!input.length || input.length > 100) {
      throw new UserError('Send 1 to 100 entries');
    }

    const errors: string[] = [];
    const rows: Entry[] = [];
    const now = new Date().toISOString();

    input.forEach((raw, i) => {
      const payload = typeof raw === 'object' && raw !== null ? { source: 'ai', ...raw } : raw;
      const r = checkEntry(payload, rules(true));
      if (!r.ok) return void errors.push(...r.errors.map((m) => `Entry ${i + 1}: ${m}`));
      rows.push({
        ...r.value,
        id: randomUUID(),
        version: 1,
        savedAt: now,
        savedBy: actor,
        voided: false,
        voidReason: '',
        createdAt: now,
        createdBy: actor,
      });
    });

    if (errors.length) throw new UserError('Some entries failed validation', 400, errors);
    await createEntries(rows);
    res.json({ saved: rows.length, ids: rows.map((r) => r.id) });
  })
);

// Session auth middleware for all other /api routes
app.use('/api', (req, res, next) => {
  const user = readToken(req.headers.cookie);
  if (!user) return void res.status(401).json({ error: 'Sign in required' });
  res.locals.user = user;
  next();
});

const me = (res: Response) => res.locals.user as string;
app.get('/api/me', (_q, res) => res.json({ user: me(res) }));

// Slice 3 routes: escrow plans, charge-from-escrow, termination preview, watchlist
registerSlice3(app);

// ───────── Helpers ─────────
const all = () => [...snapshot().latest.values()];
const live = () => all().filter((e) => !e.voided);
const sum = (es: Entry[], kind: Entry['kind']) =>
  es.filter((e) => e.kind === kind).reduce((a, e) => a + e.amountCents, 0);
const sumCharges = (es: Entry[]) =>
  es.filter((e) => e.kind === 'chargeback' || e.kind === 'escrow_charge' || e.kind === 'leaving_charge')
    .reduce((a, e) => a + e.amountCents, 0);
const open = (es: Entry[]) => ({
  incomplete: es.filter((e) => e.status === 'incomplete').length,
  issues: es.filter((e) => e.status === 'issue').length,
});
const hasHistory = (unit: string) => all().some((e) => e.unit === unit);
const rules = (strict: boolean) => ({
  activeUnits: strict ? new Set(snapshot().units.map((u) => u.unit)) : null,
  today: todayET(),
});
const needWeek = (w: string) => {
  if (weekStartOf(w) !== w) throw new UserError('Week must start on a Monday (YYYY-MM-DD)');
};

// ───────── Units: Add / Rename / Delete / Terminate (Archive) ─────────
app.get('/api/units', (_q, res) =>
  res.json(
    snapshot()
      .units.map((u) => ({
        ...u,
        entries: live().filter((e) => e.unit === u.unit).length,
        locked: hasHistory(u.unit),
        zone: zones().get(u.unit) ?? null,
        escrow: escrowBrief(u.unit),
      }))
      .sort((a, b) => natCompare(a.unit, b.unit))
  )
);

app.post(
  '/api/units',
  h(async (req, res) => {
    const unit = normUnit(req.body.unit);
    const driver = clean(req.body.driver, 60);
    const owner = clean(req.body.owner, 60);
    if (!unit || !driver) throw new UserError('Unit number (digits) and driver name are required');
    await changeUnits((units, archived) => {
      if (units.some((u) => u.unit === unit)) {
        throw new UserError(`Unit ${unit} already exists`, 409);
      }
      if (archived.some((u) => u.unit === unit)) {
        throw new UserError(`Unit ${unit} is in the archive. Use a different unit number.`, 409);
      }
      return { units: [...units, { unit, driver, owner, createdAt: new Date().toISOString() }] };
    });

    if (req.body.escrow && req.body.escrow.amount) {
      const total = toCents(String(req.body.escrow.amount ?? ''));
      const weeks = Number(req.body.escrow.weeks || 12);
      if (total && total > 0 && weeks >= 1) {
        const start = req.body.escrow.start === 'next' ? 'next' : 'current';
        const note = clean(req.body.escrow.note, 200);
        await locked((s) => {
          const now = new Date().toISOString();
          const cur = weekStartOf(todayET());
          const plan: Plan = {
            id: randomUUID(),
            version: 1,
            savedAt: now,
            savedBy: me(res),
            unit,
            totalCents: total,
            weeks,
            startWeek: start === 'next' ? addWeeks(cur, 1) : cur,
            note,
            status: 'active',
            statusNote: '',
          };
          const rows = buildRoll(s, [plan], me(res));
          return { result: { id: plan.id }, intent: { plans: [plan], entries: rows, plansFirst: true } };
        });
      }
    }
    res.json({ ok: true });
  })
);

app.patch(
  '/api/units/:unit',
  h(async (req, res) => {
    const cur = req.params.unit;
    const next = req.body.unit === undefined ? cur : normUnit(req.body.unit);
    const driver = req.body.driver === undefined ? undefined : clean(req.body.driver, 60);
    const owner = req.body.owner === undefined ? undefined : clean(req.body.owner, 60);
    if (!next || driver === '') {
      throw new UserError('Unit number (digits) and driver name cannot be empty');
    }
    await changeUnits((units, archived) => {
      const u = units.find((x) => x.unit === cur);
      if (!u) throw new UserError('Unit not found', 404);
      if (next !== cur) {
        if (hasHistory(cur)) {
          throw new UserError(
            `Unit ${cur} has ledger history, so its unit number cannot change. Terminate it and add the new number instead.`,
            409
          );
        }
        if (units.some((x) => x.unit === next) || archived.some((x) => x.unit === next)) {
          throw new UserError(`Unit ${next} already exists`, 409);
        }
      }
      return {
        units: units.map((x) =>
          x === u
            ? {
                ...x,
                unit: next,
                driver: driver ?? x.driver,
                owner: owner !== undefined ? owner : (x.owner ?? ''),
              }
            : x
        ),
      };
    });
    res.json({ ok: true });
  })
);

app.delete(
  '/api/units/:unit',
  h(async (req, res) => {
    await changeUnits((units) => {
      const u = units.find((x) => x.unit === req.params.unit);
      if (!u) throw new UserError('Unit not found', 404);
      if (hasHistory(u.unit)) {
        throw new UserError(
          `Unit ${u.unit} has financial history and cannot be deleted. Terminate it to archive it.`,
          409
        );
      }
      return { units: units.filter((x) => x !== u) };
    });
    res.json({ ok: true });
  })
);

// Terminate = settle money (escrow, unpaid chargebacks, damage lines) + archive, in one step (see slice3.ts)
app.post(
  '/api/units/:unit/archive',
  h(async (req, res) => {
    const reason = clean(req.body.reason, 200);
    const out = await terminateUnit(req.params.unit, reason, req.body.damages, me(res));
    res.json({ ok: true, ...out });
  })
);

app.get('/api/archive', (_q, res) =>
  res.json(
    snapshot()
      .archived.map((a) => {
        const es = live().filter((e) => e.unit === a.unit);
        return {
          ...a,
          entries: es.length,
          reimbursements: sum(es, 'reimbursement'),
          chargebacks: sumCharges(es),
          ...open(es),
        };
      })
      .sort((a, b) => b.terminatedAt.localeCompare(a.terminatedAt))
  )
);

app.get(
  '/api/archive/:unit',
  h((req, res) => {
    const a = snapshot().archived.find((x) => x.unit === req.params.unit);
    if (!a) throw new UserError('Archived unit not found', 404);
    const es = live()
      .filter((e) => e.unit === a.unit)
      .sort(
        (x, y) =>
          y.weekStart.localeCompare(x.weekStart) ||
          (y.eventDate || y.createdAt).localeCompare(x.eventDate || x.createdAt)
      );
    res.json({
      ...a,
      reimbursements: sum(es, 'reimbursement'),
      chargebacks: sumCharges(es),
      escrowPaid: sum(
        es.filter((e) => e.status !== 'issue'),
        'escrow'
      ),
      escrowCharged: sum(es, 'escrow_charge'),
      leaving: sum(es, 'leaving_charge'),
      entries: es,
    });
  })
);

// ───────── Weeks (Read-Only Views) ─────────
app.get('/api/weeks', (_q, res) => {
  const cur = weekStartOf(todayET());
  const by = new Map<string, Entry[]>([[cur, []]]);
  for (const e of live()) by.set(e.weekStart, [...(by.get(e.weekStart) ?? []), e]);
  // no gaps: every Monday between the oldest and newest week exists, even with zero entries
  const keys = [...by.keys()].sort();
  for (let w = keys[0]; w < keys[keys.length - 1]; w = addWeeks(w, 1)) if (!by.has(w)) by.set(w, []);
  res.json(
    [...by]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([ws, es]) => ({
        weekStart: ws,
        weekEnd: weekEnd(ws),
        reimbursements: sum(es, 'reimbursement'),
        chargebacks: sumCharges(es),
        entries: es.length,
        current: ws === cur,
        upcoming: ws > cur,
        ...open(es),
      }))
  );
});

app.get(
  '/api/weeks/:ws',
  h((req, res) => {
    const { ws } = req.params;
    needWeek(ws);
    const es = live().filter((e) => e.weekStart === ws);
    const s = snapshot();
    const info = new Map<string, { driver: string; archived: boolean }>([
      ...s.archived.map((a) => [a.unit, { driver: a.driver, archived: true }] as const),
      ...s.units.map((u) => [u.unit, { driver: u.driver, archived: false }] as const),
    ]);
    const active = new Set(s.units.map((u) => u.unit));
    const names = new Set([...active, ...es.map((e) => e.unit)]);
    const zs = zones();
    res.json({
      weekStart: ws,
      weekEnd: weekEnd(ws),
      units: [...names]
        .map((unit) => {
          const mine = es.filter((e) => e.unit === unit);
          return {
            unit,
            driver: info.get(unit)?.driver ?? '',
            archived: !active.has(unit),
            reimbursements: sum(mine, 'reimbursement'),
            chargebacks: sumCharges(mine),
            entries: mine.length,
            zone: zs.get(unit) ?? null,
            ...open(mine),
          };
        })
        .sort((a, b) => natCompare(a.unit, b.unit)),
    });
  })
);

app.get(
  '/api/weeks/:ws/units/:unit',
  h((req, res) => {
    const { ws, unit } = req.params;
    needWeek(ws);
    const s = snapshot();
    const es = live()
      .filter((e) => e.weekStart === ws && e.unit === unit)
      .sort((a, b) => (a.eventDate || a.createdAt).localeCompare(b.eventDate || b.createdAt));
    const u = s.units.find((x) => x.unit === unit) ?? s.archived.find((x) => x.unit === unit);

    const prevWs = addWeeks(ws, -1);
    const lastWeekCharges = live()
      .filter(
        (e) =>
          e.unit === unit &&
          e.weekStart === prevWs &&
          (e.kind === 'chargeback' || e.kind === 'escrow_charge' || e.kind === 'leaving_charge')
      )
      .sort((a, b) => (a.eventDate || a.createdAt).localeCompare(b.eventDate || b.createdAt));

    const allUnitEntries = live()
      .filter((e) => e.unit === unit)
      .sort(
        (a, b) =>
          b.weekStart.localeCompare(a.weekStart) ||
          (b.eventDate || b.createdAt).localeCompare(a.eventDate || a.createdAt)
      );

    const driverEs = es.filter((e) => (e.party || 'driver') === 'driver');
    const ownerEs = es.filter((e) => e.party === 'owner');

    const allDriverEs = allUnitEntries.filter((e) => (e.party || 'driver') === 'driver');
    const allOwnerEs = allUnitEntries.filter((e) => e.party === 'owner');

    res.json({
      unit,
      driver: u?.driver ?? '',
      owner: u?.owner ?? '',
      archived: !s.units.some((x) => x.unit === unit),
      reimbursements: sum(es, 'reimbursement'),
      chargebacks: sumCharges(es),
      driverTotals: {
        reimbursements: sum(driverEs, 'reimbursement'),
        chargebacks: sumCharges(driverEs),
        entriesCount: driverEs.length,
      },
      ownerTotals: {
        reimbursements: sum(ownerEs, 'reimbursement'),
        chargebacks: sumCharges(ownerEs),
        entriesCount: ownerEs.length,
      },
      lifetime: {
        reimbursements: sum(allUnitEntries, 'reimbursement'),
        chargebacks: sumCharges(allUnitEntries),
        driverReimbursements: sum(allDriverEs, 'reimbursement'),
        driverChargebacks: sumCharges(allDriverEs),
        ownerReimbursements: sum(allOwnerEs, 'reimbursement'),
        ownerChargebacks: sumCharges(allOwnerEs),
        entriesCount: allUnitEntries.length,
      },
      lastWeek: {
        weekStart: prevWs,
        weekEnd: weekEnd(prevWs),
        charges: lastWeekCharges,
        totalCharges:
          sum(lastWeekCharges, 'chargeback') +
          sum(lastWeekCharges, 'escrow_charge') +
          sum(lastWeekCharges, 'leaving_charge'),
      },
      // money actually going to the driver this week: rows marked "Held back" (issue) are not transferred
      escrow: sum(
        es.filter((e) => e.status !== 'issue'),
        'escrow'
      ),
      escrowCount: es.filter((e) => e.kind === 'escrow').length,
      escrowHeldBack: es.filter((e) => e.kind === 'escrow' && e.status === 'issue').length,
      leaving: sum(es, 'leaving_charge'),
      leavingCount: es.filter((e) => e.kind === 'leaving_charge').length,
      zone: zones().get(unit) ?? null,
      escrowNow: escrowBrief(unit),
      ...open(es),
      entries: es,
      allEntries: allUnitEntries,
    });
  })
);

// ───────── Parse Telegram Message ─────────
app.post(
  '/api/parse-telegram',
  h((req, res) => {
    const text = String(req.body.text ?? '');
    if (!text.trim()) throw new UserError('Paste or enter telegram text');
    res.json({ ok: true, data: parseTelegramMessage(text) });
  })
);

// ───────── Sync Telegram Missed Messages (Catch-Up) ─────────
app.post(
  '/api/telegram/sync',
  h(async (_req, res) => {
    const result = await catchUpMissedMessages();
    res.json({ ok: true, ...result });
  })
);

// ───────── Entries CRUD, Split & Status Updates ─────────
app.post(
  '/api/entries/:id/split',
  h(async (req, res) => {
    const { id } = req.params;
    const weeks = Number(req.body.weeks);
    if (!Number.isInteger(weeks) || weeks < 2 || weeks > 52) {
      throw new UserError('Divide weeks must be a number between 2 and 52');
    }
    const startWeek = req.body.startWeek ? String(req.body.startWeek) : undefined;

    const out = await locked((s) => {
      const cur = s.latest.get(id);
      if (!cur || cur.voided) throw new UserError('Entry not found or already voided', 404);
      if (cur.kind !== 'chargeback' && cur.kind !== 'leaving_charge') {
        throw new UserError('Only charges can be divided across weeks');
      }
      if (cur.amountCents < weeks) {
        throw new UserError('Amount is too small to divide into that many weeks');
      }

      const sw = startWeek && weekStartOf(startWeek) === startWeek ? startWeek : cur.weekStart;
      const installments = splitInstallments(cur.amountCents, weeks, sw);
      const now = new Date().toISOString();
      const newEntries: Entry[] = [];

      for (const inst of installments) {
        newEntries.push({
          id: randomUUID(),
          version: 1,
          savedAt: now,
          savedBy: me(res),
          weekStart: inst.weekStart,
          eventDate: cur.eventDate || todayET(),
          unit: cur.unit,
          kind: cur.kind,
          amountCents: inst.amountCents,
          note: `Part ${inst.n}/${inst.weeks}: ${cur.note || 'Charge'}`,
          status: 'incomplete',
          statusNote: cur.statusNote
            ? `(Split ${inst.n}/${inst.weeks}) ${cur.statusNote}`
            : `Installment ${inst.n} of ${inst.weeks}`,
          source: cur.source,
          sourceRef: cur.sourceRef,
          weekReason: cur.weekReason,
          voided: false,
          voidReason: '',
          createdAt: now,
          createdBy: me(res),
          party: cur.party || 'driver',
        });
      }

      const voidedOriginal: Entry = {
        ...cur,
        voided: true,
        voidReason: `Split into ${weeks} weekly installments`,
        version: cur.version + 1,
        savedAt: now,
        savedBy: me(res),
      };

      return {
        result: {
          originalId: cur.id,
          created: newEntries.length,
          entries: newEntries,
        },
        intent: {
          entries: [voidedOriginal, ...newEntries],
          expect: [[cur.id, cur.version]],
        },
      };
    });

    res.json({ ok: true, ...out });
  })
);

app.post(
  '/api/entries',
  h(async (req, res) => {
    const input: unknown[] = Array.isArray(req.body.entries) ? req.body.entries : [];
    if (!input.length || input.length > 100) throw new UserError('Send 1 to 100 entries');
    const errors: string[] = [];
    const rows: Entry[] = [];
    const now = new Date().toISOString();

    input.forEach((raw, i) => {
      const r = checkEntry(raw, rules(true));
      if (!r.ok) return void errors.push(...r.errors.map((m) => `Entry ${i + 1}: ${m}`));
      rows.push({
        ...r.value,
        id: randomUUID(),
        version: 1,
        savedAt: now,
        savedBy: me(res),
        voided: false,
        voidReason: '',
        createdAt: now,
        createdBy: me(res),
      });
    });

    if (errors.length) throw new UserError('Some entries were rejected', 400, errors);
    await createEntries(rows);
    res.json({ saved: rows.length, ids: rows.map((r) => r.id) });
  })
);

app.patch(
  '/api/entries/:id',
  h(async (req, res) => {
    const cur = snapshot().latest.get(req.params.id);
    const b = req.body;
    if (!cur || cur.voided) throw new UserError('Entry not found', 404);
    const expected = Number(b.expectedVersion);
    if (!Number.isInteger(expected)) throw new UserError('expectedVersion is required');

    const patch: Record<string, unknown> = {};
    for (const k of ['kind', 'note', 'status', 'statusNote', 'party', 'sourceRef']) {
      if (b[k] !== undefined) patch[k] = b[k];
    }
    // escrow / leaving-charge rows keep their type; normal rows cannot be turned into system rows
    const isSystem = (SYSTEM_KINDS as readonly string[]).includes(cur.kind);
    if (isSystem) delete patch.kind;
    else if ((SYSTEM_KINDS as readonly string[]).includes(String(patch.kind))) {
      throw new UserError('That type is managed by the system');
    }
    if (b.amount !== undefined || b.amountCents !== undefined) {
      patch.amount = b.amount;
      patch.amountCents = b.amountCents;
    }

    const r = checkEntry({ ...cur, ...patch }, { ...rules(false), kinds: ALL_KINDS, system: true });
    if (!r.ok) throw new UserError('Changes rejected', 400, r.errors);
    assertEscrowRoom(cur, r.value);

    await saveVersion(
      {
        ...cur,
        ...r.value,
        version: expected + 1,
        savedAt: new Date().toISOString(),
        savedBy: me(res),
      },
      expected
    );
    res.json({ ok: true, version: expected + 1 });
  })
);

app.post(
  '/api/entries/:id/void',
  h(async (req, res) => {
    const cur = snapshot().latest.get(req.params.id);
    const reason = clean(req.body.reason, 200);
    const expected = Number(req.body.expectedVersion);
    if (!cur || cur.voided) throw new UserError('Entry not found or already voided', 404);
    if (!reason || !Number.isInteger(expected)) {
      throw new UserError('A reason and expectedVersion are required');
    }
    await saveVersion(
      {
        ...cur,
        voided: true,
        voidReason: reason,
        version: expected + 1,
        savedAt: new Date().toISOString(),
        savedBy: me(res),
      },
      expected
    );
    res.json({ ok: true });
  })
);

app.get(
  '/api/entries/:id/history',
  h((req, res) => {
    const v = snapshot().versions.get(req.params.id);
    if (!v) throw new UserError('Entry not found', 404);
    res.json(v);
  })
);

await ensureHeaders();
await refresh();
await rollEscrow().catch((e) => console.error('escrow roll failed (next poll retries)', e));
await startTelegramListener().catch((e) => console.error('telegram listener start failed', e));
// every 15s: refresh from the sheet, then create any escrow rows that became due (a new Monday arrives -> its rows appear)
setInterval(async () => {
  try {
    await refresh();
    await rollEscrow();
  } catch (e) {
    console.error('poll failed', e);
  }
}, 15_000);

const PORT = Number(process.env.PORT ?? 3000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Reconciliation app running on port ${PORT}`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://<your-LAN-IP>:${PORT}`);
});
