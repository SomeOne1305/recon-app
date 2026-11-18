// Slice 3: escrow plans, charges taken from escrow, termination settlement, and the attention watchlist.
// All new logic lives here; server.ts only mounts these routes and calls a few helpers.
//
// Ledger conventions (all rows live in the existing `entries` tab, no new columns):
//   kind 'escrow'          weekly escrow payment PAID TO the driver. status: done = paid, incomplete = pending,
//                          issue = held back (money stays in escrow). source_ref = esc:<planId>:<n>
//   kind 'escrow_charge'   an amount taken OUT of escrow to cover a charge. source_ref = escchg:<planId>:...
//   kind 'leaving_charge'  damage charge entered in the termination window. source_ref = settle:<unit>:dmg:<i>
//   escrow refund at exit  kind 'escrow', source_ref = settle:<unit>:refund
//   escrow applied at exit kind 'escrow_charge', source_ref = settle:<unit>:applied

import type { Express, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import {
  ALL_KINDS,
  MAX_CENTS,
  UserError,
  addWeeks,
  checkEntry,
  clean,
  installmentAmount,
  natCompare,
  toCents,
  todayET,
  weekEnd,
  weekStartOf,
} from './domain.js';
import { locked, snapshot, type Entry, type Plan } from './sheets.js';

type Snap = ReturnType<typeof snapshot>;

const fmt = (c: number) => (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const SYS_RULES = () => ({ activeUnits: null, today: todayET(), kinds: ALL_KINDS, system: true });

const mkEntry = (raw: Record<string, unknown>, actor: string, now: string): Entry => {
  const r = checkEntry({ source: 'system', ...raw }, SYS_RULES());
  if (!r.ok) throw new UserError(r.errors[0], 400, r.errors);
  return {
    ...r.value,
    id: randomUUID(),
    version: 1,
    savedAt: now,
    savedBy: actor,
    voided: false,
    voidReason: '',
    createdAt: now,
    createdBy: actor,
  };
};

/** New version of an existing entry (same optimistic-locking pattern the app already uses). */
const bump = (cur: Entry, patch: Record<string, unknown>, actor: string, now: string): Entry => {
  const r = checkEntry({ ...cur, ...patch }, SYS_RULES());
  if (!r.ok) throw new UserError(r.errors[0], 400, r.errors);
  return { ...cur, ...r.value, version: cur.version + 1, savedAt: now, savedBy: actor };
};

const voidIt = (cur: Entry, reason: string, actor: string, now: string): Entry => ({
  ...cur,
  voided: true,
  voidReason: reason,
  version: cur.version + 1,
  savedAt: now,
  savedBy: actor,
});

const liveOf = (s: Snap, unit: string) =>
  [...s.latest.values()].filter((e) => e.unit === unit && !e.voided);

// ───────────────────────── Escrow math ─────────────────────────

export const activePlan = (unit: string, s: Snap = snapshot()) =>
  [...s.plans.values()].find((p) => p.unit === unit && p.status === 'active');

/** Active plan if there is one, otherwise the most recent plan (so a terminated unit still shows its history). */
const planOf = (unit: string, s: Snap) => {
  const ps = [...s.plans.values()].filter((p) => p.unit === unit);
  return ps.find((p) => p.status === 'active') ?? ps.sort((a, b) => b.savedAt.localeCompare(a.savedAt))[0];
};

export function escrowStats(p: Plan, s: Snap) {
  let paid = 0;
  let pending = 0;
  let heldBack = 0;
  let charged = 0;
  let refunded = 0;
  let applied = 0;
  for (const e of s.latest.values()) {
    if (e.voided || e.unit !== p.unit) continue;
    if (e.kind === 'escrow' && e.sourceRef.startsWith(`esc:${p.id}:`)) {
      if (e.status === 'done') paid += e.amountCents;
      else if (e.status === 'incomplete') pending += e.amountCents;
      else heldBack += e.amountCents;
    } else if (e.kind === 'escrow_charge' && e.sourceRef.startsWith(`escchg:${p.id}:`)) {
      charged += e.amountCents;
    } else if (e.kind === 'escrow' && e.sourceRef === `settle:${p.unit}:refund`) {
      refunded += e.amountCents;
    } else if (e.kind === 'escrow_charge' && e.sourceRef === `settle:${p.unit}:applied`) {
      applied += e.amountCents;
    }
  }
  // "held" = money still sitting in escrow. Once a plan is closed/cancelled nothing is held any more.
  const held = p.status === 'active' ? Math.max(0, p.totalCents - paid - charged) : 0;
  return { paid, pending, heldBack, charged, refunded, applied, held };
}

/**
 * Creates the weekly escrow rows that are due but do not exist yet (one per plan per week).
 * Idempotent: a row is identified by its source_ref, so running this any number of times is safe.
 * A voided row still counts as "exists" (voiding = deliberately skipping that week).
 */
export function buildRoll(s: Snap, plans: Iterable<Plan>, actor = 'system'): Entry[] {
  const cur = weekStartOf(todayET());
  const now = new Date().toISOString();
  const existing = new Set([...s.latest.values()].map((e) => e.sourceRef).filter(Boolean));
  const out: Entry[] = [];
  for (const p of plans) {
    if (p.status !== 'active') continue;
    const st = escrowStats(p, s);
    let room = st.held - st.pending; // never schedule more than is actually left in escrow
    for (let n = 1; n <= p.weeks; n++) {
      const ws = addWeeks(p.startWeek, n - 1);
      if (ws > cur) break;
      const ref = `esc:${p.id}:${n}`;
      if (existing.has(ref)) continue;
      const amt = Math.min(installmentAmount(p.totalCents, p.weeks, n), room);
      if (amt < 1) continue;
      room -= amt;
      out.push(
        mkEntry(
          {
            unit: p.unit,
            kind: 'escrow',
            amountCents: amt,
            note: `Escrow ${n}/${p.weeks}`,
            status: 'incomplete',
            weekStart: ws,
            sourceRef: ref,
          },
          actor,
          now
        )
      );
    }
  }
  return out;
}

/** Called at startup and after every poll: when a new Monday arrives its escrow rows appear automatically. */
export async function rollEscrow() {
  const n = await locked((s) => {
    const rows = buildRoll(s, s.plans.values());
    return rows.length ? { result: rows.length, intent: { entries: rows } } : { result: 0 };
  });
  if (n) console.log(`Escrow: created ${n} weekly payment row(s)`);
}

/** Guard used when an escrow payment is marked Done: you cannot pay out more than is still held. */
export function assertEscrowRoom(cur: Entry, next: { status: string; amountCents: number }, s: Snap = snapshot()) {
  if (cur.kind !== 'escrow' || next.status !== 'done') return;
  const m = /^esc:([^:]+):/.exec(cur.sourceRef);
  const p = m && s.plans.get(m[1]);
  if (!p || p.status !== 'active') return;
  const st = escrowStats(p, s);
  const paidWithoutThis = st.paid - (cur.status === 'done' ? cur.amountCents : 0);
  const room = p.totalCents - paidWithoutThis - st.charged;
  if (next.amountCents > room) {
    throw new UserError(`Escrow only has ${fmt(Math.max(room, 0))} left to pay out. Lower this amount.`, 409);
  }
}

// ───────────────────────── Zones (who needs attention) ─────────────────────────

const money = (key: string, dflt: number) => {
  const raw = process.env[key];
  const v = raw === undefined || raw === '' ? NaN : Number(raw);
  return Math.round((Number.isFinite(v) && v >= 0 ? v : dflt) * 100);
};
const count = (key: string, dflt: number) => {
  const v = Number(process.env[key]);
  return process.env[key] && Number.isInteger(v) && v >= 0 ? v : dflt;
};

// Amounts are in money units (not cents) in .env, e.g. ZONE_YELLOW_UNPAID=300
export const ZONE_CFG = {
  yellowUnpaid: money('ZONE_YELLOW_UNPAID', 300), // unpaid chargebacks
  redUnpaid: money('ZONE_RED_UNPAID', 1000),
  redUncovered: money('ZONE_RED_UNCOVERED', 500), // unpaid chargebacks that escrow cannot cover
  yellow4wk: money('ZONE_YELLOW_4WK', 600), // charges in the current + previous 3 weeks
  red4wk: money('ZONE_RED_4WK', 1500),
  yellowWeeks: count('ZONE_YELLOW_WEEKS', 3), // weeks with a charge, out of the current + previous 5
  redWeeks: count('ZONE_RED_WEEKS', 5),
  yellowIssues: count('ZONE_YELLOW_ISSUES', 2), // open "issue" entries
};

export interface Zone {
  level: 'green' | 'yellow' | 'red';
  reasons: string[];
  unpaidCents: number;
  last4Cents: number;
  allTimeChargesCents: number;
  chargedWeeks: number;
  heldCents: number;
  issues: number;
}

export function zones(s: Snap = snapshot()): Map<string, Zone> {
  const cur = weekStartOf(todayET());
  const from4 = addWeeks(cur, -3);
  const from6 = addWeeks(cur, -5);
  const c = ZONE_CFG;
  const out = new Map<string, Zone>();

  const byUnit = new Map<string, Entry[]>();
  for (const e of s.latest.values()) {
    if (e.voided) continue;
    byUnit.set(e.unit, [...(byUnit.get(e.unit) ?? []), e]);
  }

  for (const u of s.units) {
    const es = byUnit.get(u.unit) ?? [];
    let unpaid = 0;
    let last4 = 0;
    let allCharges = 0;
    let issues = 0;
    const weeks = new Set<string>();
    for (const e of es) {
      if (e.status === 'issue') issues++;
      // a "charge event" is a chargeback, leaving charge, or an ad-hoc charge taken from escrow (not one already linked to a chargeback)
      const isCharge =
        e.kind === 'chargeback' || e.kind === 'leaving_charge' || (e.kind === 'escrow_charge' && !e.sourceRef.includes(':cb:') && !e.sourceRef.startsWith('settle:'));
      if ((e.kind === 'chargeback' || e.kind === 'leaving_charge') && e.status !== 'done') unpaid += e.amountCents;
      if (isCharge) {
        allCharges += e.amountCents;
        if (e.weekStart <= cur) {
          if (e.weekStart >= from4) last4 += e.amountCents;
          if (e.weekStart >= from6) weeks.add(e.weekStart);
        }
      }
    }
    const plan = activePlan(u.unit, s);
    const held = plan ? escrowStats(plan, s).held : 0;
    const chargedWeeks = weeks.size;

    const reasons: string[] = [];
    let level: Zone['level'] = 'green';
    const raise = (l: 'yellow' | 'red', why: string) => {
      reasons.push(why);
      if (l === 'red' || level === 'green') level = l;
    };

    if (unpaid >= c.redUnpaid) raise('red', `Unpaid chargebacks ${fmt(unpaid)}`);
    else if (unpaid >= c.redUncovered && unpaid > held) {
      raise('red', `Unpaid chargebacks ${fmt(unpaid)} but escrow holds only ${fmt(held)}`);
    } else if (unpaid >= c.yellowUnpaid) raise('yellow', `Unpaid chargebacks ${fmt(unpaid)}`);

    if (last4 >= c.red4wk) raise('red', `Charges in last 4 weeks ${fmt(last4)}`);
    else if (last4 >= c.yellow4wk) raise('yellow', `Charges in last 4 weeks ${fmt(last4)}`);

    if (chargedWeeks >= c.redWeeks) raise('red', `Charged in ${chargedWeeks} of the last 6 weeks`);
    else if (chargedWeeks >= c.yellowWeeks) raise('yellow', `Charged in ${chargedWeeks} of the last 6 weeks`);

    if (issues >= c.yellowIssues) raise('yellow', `${issues} open issues`);

    out.set(u.unit, { level, reasons, unpaidCents: unpaid, last4Cents: last4, allTimeChargesCents: allCharges, chargedWeeks, heldCents: held, issues });
  }
  return out;
}

// ───────────────────────── Escrow view ─────────────────────────

function escrowView(unit: string) {
  const s = snapshot();
  const p = planOf(unit, s);
  const cur = weekStartOf(todayET());
  if (!p) return { plan: null, currentWeek: cur };
  const st = escrowStats(p, s);

  const byRef = new Map<string, Entry>();
  const charges: Entry[] = [];
  for (const e of s.latest.values()) {
    if (e.unit !== unit) continue;
    if (e.kind === 'escrow' && e.sourceRef.startsWith(`esc:${p.id}:`)) byRef.set(e.sourceRef, e);
    if (!e.voided && e.kind === 'escrow_charge' && (e.sourceRef.startsWith(`escchg:${p.id}:`) || e.sourceRef.startsWith(`settle:${unit}:`))) {
      charges.push(e);
    }
  }

  const schedule = Array.from({ length: p.weeks }, (_, i) => {
    const n = i + 1;
    const ws = addWeeks(p.startWeek, i);
    const e = byRef.get(`esc:${p.id}:${n}`);
    let state: string;
    if (e && !e.voided) state = e.status === 'done' ? 'paid' : e.status === 'issue' ? 'held' : 'pending';
    else if (e) state = 'skipped';
    else if (p.status !== 'active') state = 'closed';
    else state = ws > cur ? 'upcoming' : 'skipped';
    return {
      n,
      weekStart: ws,
      weekEnd: weekEnd(ws),
      scheduledCents: installmentAmount(p.totalCents, p.weeks, n),
      amountCents: e && !e.voided ? e.amountCents : 0,
      entryId: e?.id ?? null,
      state,
      statusNote: e && !e.voided ? e.statusNote : e?.voidReason ?? '',
      current: ws === cur,
    };
  });

  return {
    plan: {
      id: p.id,
      totalCents: p.totalCents,
      weeks: p.weeks,
      startWeek: p.startWeek,
      note: p.note,
      status: p.status,
      statusNote: p.statusNote,
    },
    stats: st,
    schedule,
    charges: charges
      .sort((a, b) => a.weekStart.localeCompare(b.weekStart) || a.createdAt.localeCompare(b.createdAt))
      .map((e) => ({ id: e.id, weekStart: e.weekStart, amountCents: e.amountCents, note: e.note, createdAt: e.createdAt })),
    canCancel: p.status === 'active' && st.paid === 0 && st.charged === 0,
    currentWeek: cur,
  };
}

/** Small summary used by the week/unit detail (drives the "From escrow" button). */
export function escrowBrief(unit: string, s: Snap = snapshot()) {
  const p = activePlan(unit, s);
  return { active: !!p, heldCents: p ? escrowStats(p, s).held : 0 };
}

// ───────────────────────── Termination ─────────────────────────

const unpaidChargebacks = (unit: string, s: Snap) =>
  liveOf(s, unit)
    .filter((e) => e.kind === 'chargeback' && e.status !== 'done')
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart) || a.createdAt.localeCompare(b.createdAt));

function terminationPreview(unit: string) {
  const s = snapshot();
  const u = s.units.find((x) => x.unit === unit);
  if (!u) throw new UserError('Unit not found', 404);
  const p = activePlan(unit, s);
  const st = p ? escrowStats(p, s) : null;
  const unpaid = unpaidChargebacks(unit, s);
  return {
    unit,
    driver: u.driver,
    settlementWeek: addWeeks(weekStartOf(todayET()), 1),
    plan: p ? { totalCents: p.totalCents, weeks: p.weeks, ...st! } : null,
    heldCents: st?.held ?? 0,
    unpaid: unpaid.map((e) => ({
      id: e.id,
      weekStart: e.weekStart,
      amountCents: e.amountCents,
      note: e.note,
      status: e.status,
      statusNote: e.statusNote,
    })),
    unpaidTotalCents: unpaid.reduce((a, e) => a + e.amountCents, 0),
  };
}

/**
 * Terminates a unit and settles money in ONE write:
 *  1. unpaid chargebacks are taken from escrow automatically (oldest first),
 *  2. then the manual damage lines (each with a note),
 *  3. whatever escrow is left is refunded to the driver, whatever escrow cannot cover stays owed,
 *  4. every settlement row lands in NEXT week, then the plan is closed and the unit archived.
 * Retry-safe: if a previous attempt already wrote the settlement rows, only the missing steps run.
 */
export async function terminateUnit(unit: string, reason: string, damagesRaw: unknown, actor: string) {
  if (!reason) throw new UserError('A termination reason is required');
  const lines = Array.isArray(damagesRaw) ? damagesRaw : [];
  if (lines.length > 20) throw new UserError('Too many charge lines (max 20)');
  const damages = lines.map((d: any, i: number) => {
    const cents = Number.isSafeInteger(d?.amountCents) ? d.amountCents : toCents(String(d?.amount ?? ''));
    const note = clean(d?.note, 200);
    if (!cents || cents > MAX_CENTS) throw new UserError(`Charge ${i + 1}: amount must be between 0.01 and 100,000.00`);
    if (!note) throw new UserError(`Charge ${i + 1}: add a note explaining why the driver is charged`);
    return { cents, note };
  });

  return locked((s) => {
    const u = s.units.find((x) => x.unit === unit);
    if (!u) throw new UserError('Unit not found', 404);
    const now = new Date().toISOString();
    const today = todayET();
    const W = addWeeks(weekStartOf(today), 1);
    const plan = activePlan(unit, s);
    const already = [...s.latest.values()].some((e) => e.unit === unit && e.sourceRef.startsWith(`settle:${unit}:`));

    const entries: Entry[] = [];
    const expect: Array<[string, number]> = [];
    const result = { settlementWeek: W, heldCents: 0, unpaidChargebacksCents: 0, damagesCents: 0, appliedCents: 0, refundCents: 0, owedCents: 0 };

    if (!already) {
      const held = plan ? escrowStats(plan, s).held : 0;
      let remaining = held;
      const cover = (amount: number) => {
        const take = Math.min(remaining, amount);
        remaining -= take;
        return take;
      };
      const tag = 'Covered from escrow at termination';
      const settleFields = { weekStart: W, eventDate: today, weekReason: 'Settlement carried to the week after termination' };

      for (const cb of unpaidChargebacks(unit, s)) {
        result.unpaidChargebacksCents += cb.amountCents;
        const take = cover(cb.amountCents);
        if (take === cb.amountCents) {
          entries.push(bump(cb, { status: 'done', statusNote: cb.statusNote ? `${tag} (was: ${cb.statusNote})` : tag }, actor, now));
          expect.push([cb.id, cb.version]);
        } else if (take > 0) {
          const note = `Escrow covered ${fmt(take)} of ${fmt(cb.amountCents)}; ${fmt(cb.amountCents - take)} still owed`;
          entries.push(bump(cb, { statusNote: note }, actor, now));
          expect.push([cb.id, cb.version]);
        }
      }

      damages.forEach((d, i) => {
        result.damagesCents += d.cents;
        const take = cover(d.cents);
        const full = take === d.cents;
        entries.push(
          mkEntry(
            {
              ...settleFields,
              unit,
              kind: 'leaving_charge',
              amountCents: d.cents,
              note: d.note,
              status: full ? 'done' : 'incomplete',
              statusNote: full ? tag : take > 0 ? `Escrow covered ${fmt(take)} of ${fmt(d.cents)}; ${fmt(d.cents - take)} still owed` : 'Not covered by escrow: still owed by driver',
              sourceRef: `settle:${unit}:dmg:${i + 1}`,
            },
            actor,
            now
          )
        );
      });

      const total = result.unpaidChargebacksCents + result.damagesCents;
      result.heldCents = held;
      result.appliedCents = Math.min(held, total);
      result.refundCents = remaining;
      result.owedCents = total - result.appliedCents;

      if (result.appliedCents > 0) {
        entries.push(
          mkEntry(
            {
              ...settleFields,
              unit,
              kind: 'escrow_charge',
              amountCents: result.appliedCents,
              note: 'Escrow applied to unpaid chargebacks and leaving charges',
              status: 'done',
              sourceRef: `settle:${unit}:applied`,
            },
            actor,
            now
          )
        );
      }
      if (result.refundCents > 0) {
        entries.push(
          mkEntry(
            {
              ...settleFields,
              unit,
              kind: 'escrow',
              amountCents: result.refundCents,
              note: 'Escrow refund at termination',
              status: 'incomplete',
              sourceRef: `settle:${unit}:refund`,
            },
            actor,
            now
          )
        );
      }

      // pending weekly escrow payments are replaced by the refund above, so they must not be paid twice
      if (plan) {
        for (const e of liveOf(s, unit)) {
          if (e.kind === 'escrow' && e.status === 'incomplete' && e.sourceRef.startsWith(`esc:${plan.id}:`)) {
            entries.push(voidIt(e, 'Replaced by termination settlement', actor, now));
            expect.push([e.id, e.version]);
          }
        }
      }
    }

    const plans: Plan[] = plan
      ? [{ ...plan, version: plan.version + 1, status: 'closed', statusNote: 'Closed at termination', savedAt: now, savedBy: actor }]
      : [];

    return {
      result,
      intent: {
        entries,
        expect,
        plans,
        units: (units, _archived) => ({
          units: units.filter((x) => x !== u),
          archived: { ...u, terminatedAt: now, terminatedBy: actor, reason },
        }),
      },
    };
  });
}

// ───────────────────────── Routes ─────────────────────────

type H = (req: Request, res: Response) => Promise<unknown> | unknown;
const h = (fn: H) => async (req: Request, res: Response) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (e instanceof UserError) return void res.status(e.status).json({ error: e.message, errors: e.errors });
    console.error(e);
    res.status(502).json({ error: 'Could not reach Google Sheets. Nothing was changed.' });
  }
};
const me = (res: Response) => res.locals.user as string;

export function registerSlice3(app: Express) {
  // Escrow plan + weekly schedule for one unit (also works for terminated units: shows the closed plan)
  app.get('/api/units/:unit/escrow', h((req, res) => res.json(escrowView(req.params.unit))));

  app.post(
    '/api/units/:unit/escrow',
    h(async (req, res) => {
      const unit = req.params.unit;
      const total = toCents(String(req.body.amount ?? ''));
      const weeks = Number(req.body.weeks);
      if (!total || total > MAX_CENTS * 10) throw new UserError('Escrow total must be a valid amount');
      if (!Number.isInteger(weeks) || weeks < 1 || weeks > 104) throw new UserError('Weeks must be a whole number from 1 to 104');
      if (total < weeks) throw new UserError('Escrow total is too small for that many weeks');
      if (installmentAmount(total, weeks, 1) > MAX_CENTS) throw new UserError('Each weekly payment must be at most 100,000.00');
      const start = req.body.start === 'next' ? 'next' : 'current';
      const note = clean(req.body.note, 200);

      const out = await locked((s) => {
        if (!s.units.some((u) => u.unit === unit)) throw new UserError('Unit not found or already terminated', 404);
        if (activePlan(unit, s)) throw new UserError('This unit already has an active escrow plan', 409);
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
        const rows = buildRoll(s, [plan], me(res)); // first week's payment row appears immediately if the plan starts now
        return { result: { id: plan.id, startWeek: plan.startWeek, created: rows.length }, intent: { plans: [plan], entries: rows, plansFirst: true } };
      });
      res.json({ ok: true, ...out });
    })
  );

  // Take money out of escrow to cover a charge (ad-hoc, or linked to an existing unpaid chargeback)
  app.post(
    '/api/units/:unit/escrow/charge',
    h(async (req, res) => {
      const unit = req.params.unit;
      const chargebackId = req.body.chargebackId ? String(req.body.chargebackId) : '';
      const typedNote = clean(req.body.note, 200);
      const typedCents = toCents(String(req.body.amount ?? ''));
      const out = await locked((s) => {
        const plan = activePlan(unit, s);
        if (!plan) throw new UserError('This unit has no active escrow plan', 409);
        const held = escrowStats(plan, s).held;
        const now = new Date().toISOString();
        const entries: Entry[] = [];
        const expect: Array<[string, number]> = [];
        let cents: number;
        let note: string;
        let week = weekStartOf(todayET());
        let ref = `escchg:${plan.id}:${randomUUID().slice(0, 8)}`;
        if (chargebackId) {
          const cb = s.latest.get(chargebackId);
          if (!cb || cb.voided || cb.unit !== unit || cb.kind !== 'chargeback') throw new UserError('Chargeback not found', 404);
          if (cb.status === 'done') throw new UserError('This chargeback is already marked Done', 409);
          ref = `escchg:${plan.id}:cb:${cb.id}`;
          if ([...s.latest.values()].some((e) => !e.voided && e.sourceRef === ref)) throw new UserError('This chargeback was already charged from escrow', 409);
          cents = cb.amountCents;
          note = clean(`Chargeback from escrow: ${cb.note || 'no description'}`, 200);
          week = cb.weekStart;
          const was = cb.statusNote ? ` (was: ${cb.statusNote})` : '';
          entries.push(bump(cb, { status: 'done', statusNote: `Charged from escrow${was}` }, me(res), now));
          expect.push([cb.id, cb.version]);
        } else {
          if (!typedCents) throw new UserError('Enter a valid amount');
          if (!typedNote) throw new UserError('Add a note explaining the charge');
          cents = typedCents;
          note = typedNote;
        }
        if (cents > held) throw new UserError(`Escrow only holds ${fmt(held)}. Charge the rest from salary instead.`, 409);
        entries.push(
          mkEntry({ unit, kind: 'escrow_charge', amountCents: cents, note, status: 'done', weekStart: week, sourceRef: ref }, me(res), now)
        );
        return { result: { chargedCents: cents, heldAfterCents: held - cents }, intent: { entries, expect } };
      });
      res.json({ ok: true, ...out });
    })
  );

  // Cancel a plan that has not paid or charged anything yet (fixes a wrong total / wrong weeks)
  app.post(
    '/api/units/:unit/escrow/cancel',
    h(async (req, res) => {
      const unit = req.params.unit;
      await locked((s) => {
        const plan = activePlan(unit, s);
        if (!plan) throw new UserError('No active escrow plan', 404);
        const st = escrowStats(plan, s);
        if (st.paid > 0 || st.charged > 0) {
          throw new UserError('Escrow already has payments or charges, so it cannot be cancelled. Mark rows Held back or void them instead.', 409);
        }
        const now = new Date().toISOString();
        const entries: Entry[] = [];
        const expect: Array<[string, number]> = [];
        for (const e of liveOf(s, unit)) {
          if (e.kind === 'escrow' && e.sourceRef.startsWith(`esc:${plan.id}:`)) {
            entries.push(voidIt(e, 'Escrow plan cancelled', me(res), now));
            expect.push([e.id, e.version]);
          }
        }
        return {
          result: null,
          intent: { entries, expect, plans: [{ ...plan, version: plan.version + 1, status: 'cancelled', statusNote: 'Cancelled before any payment', savedAt: now, savedBy: me(res) }] },
        };
      });
      res.json({ ok: true });
    })
  );

  app.get('/api/units/:unit/termination-preview', h((req, res) => res.json(terminationPreview(req.params.unit))));

  app.get('/api/watchlist', (_q, res) => {
    const s = snapshot();
    const zs = zones(s);
    const items = s.units
      .map((u) => ({ unit: u.unit, driver: u.driver, owner: u.owner, ...zs.get(u.unit)! }))
      .filter((x) => x.level !== 'green')
      .sort(
        (a, b) =>
          Number(b.level === 'red') - Number(a.level === 'red') ||
          b.unpaidCents - a.unpaidCents ||
          b.allTimeChargesCents - a.allTimeChargesCents ||
          b.last4Cents - a.last4Cents ||
          natCompare(a.unit, b.unit)
      );
    res.json({ week: weekStartOf(todayET()), items, thresholds: ZONE_CFG });
  });
}
