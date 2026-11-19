import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  parseTelegramMessage,
  normUnit,
  weekStartOf,
  todayET,
  type Kind,
  type Party,
} from './domain.js';
import { createEntries, changeUnits, snapshot, type Entry } from './sheets.js';

export interface TelegramParsedExpense {
  unit?: string;
  amountCents?: number;
  reportRef?: string;
  party: Party;
  note: string;
}

const SYNC_STATE_FILE = path.resolve('.tg-sync-state.json');

interface SyncState {
  lastSeenIds: Record<string, number>;
}

function loadSyncState(): SyncState {
  try {
    if (fs.existsSync(SYNC_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(SYNC_STATE_FILE, 'utf-8'));
    }
  } catch {}
  return { lastSeenIds: {} };
}

function saveSyncState(state: SyncState) {
  try {
    fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[Telegram] Failed to save sync state:', err);
  }
}

/**
 * Finds the latest eventDate or createdAt among all Telegram entries in Google Sheets.
 * Returns YYYY-MM-DD or null if no telegram entries exist.
 */
export function getLastTelegramEntryDate(): string | null {
  const s = snapshot();
  let latestDate: string | null = null;
  for (const e of s.latest.values()) {
    if (e.source === 'telegram') {
      const d = e.eventDate || (e.createdAt ? e.createdAt.slice(0, 10) : null);
      if (d && (!latestDate || d > latestDate)) {
        latestDate = d;
      }
    }
  }
  return latestDate;
}

/**
 * Uses Groq LLM (openai/gpt-oss-120b) to extract expense details from freeform text.
 */
async function parseWithGroq(
  text: string,
  kind: Kind
): Promise<TelegramParsedExpense | null> {
  const groqKey = process.env.GROQ?.trim();
  if (!groqKey) return null;

  const prompt = `You are a logistics fleet accounting assistant. Extract financial entry details from this Telegram message sent to a fleet dispatch group.
The entry type is: ${kind.toUpperCase()}.

Message:
"""${text}"""

Extract and respond ONLY with a raw JSON object (no markdown formatting, no backticks, just the json):
{
  "unit": string or null (the truck or unit number, digits only e.g. "121", "997", "111", "124"),
  "amount": number or null (e.g. 250.00, 113.00, 500.00),
  "reportRef": string or null (strictly for EFS Reference codes or Money Transfer codes in charges. For reimbursements, set to null),
  "party": "driver" or "owner" (if message says "charge owner" or "owner of unit" use "owner", otherwise default "driver"),
  "note": string (clean summary description. If there is a Load #, include it in the note, e.g. "Detention (Load 1283799)")
}`;

  try {
    let res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${groqKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      }),
    });

    let data: any = await res.json();
    if (res.status === 429 || data.error?.code === 'rate_limit_exceeded') {
      console.log('[Telegram Groq Rate Limit] Backing off 1.5s before retrying...');
      await new Promise((r) => setTimeout(r, 1500));
      res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${groqKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'openai/gpt-oss-120b',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
        }),
      });
      data = await res.json();
    }

    if (data.error) {
      console.error('[Telegram Groq Error]:', data.error);
      return null;
    }

    const raw = data.choices?.[0]?.message?.content?.trim() ?? '{}';
    const cleanJson = raw.replace(/^```json/i, '').replace(/^```/i, '').replace(/```$/i, '').trim();
    const parsed = JSON.parse(cleanJson);

    const unit = normUnit(parsed.unit);
    const amountVal = Number(parsed.amount);
    const amountCents = !isNaN(amountVal) && amountVal > 0 ? Math.round(amountVal * 100) : undefined;
    const party: Party = parsed.party === 'owner' ? 'owner' : 'driver';
    const note = String(parsed.note || '').trim() || (kind === 'chargeback' ? 'Telegram charge' : 'Telegram reimbursement');
    // Report reference is ONLY used in charges (EFS reference code). Never in reimbursements!
    const reportRef = kind === 'chargeback' && parsed.reportRef ? String(parsed.reportRef).trim() : undefined;

    return {
      unit: unit || undefined,
      amountCents,
      reportRef,
      party,
      note,
    };
  } catch (err) {
    console.error('[Telegram Groq Parse Exception]:', err);
    return null;
  }
}

/**
 * Hybrid Parser: Regex first, Groq LLM fallback for freeform text.
 */
export async function parseExpense(
  text: string,
  kind: Kind
): Promise<TelegramParsedExpense | null> {
  const cleanText = text.replace(/[*_`]/g, '').trim();
  const isOwner = /(?:charge\s+owner|owner\s+of\s+unit|\bowner\b)/i.test(cleanText);
  const party: Party = isOwner ? 'owner' : 'driver';

  // 1. Try regex parser
  const reg = parseTelegramMessage(cleanText);
  if (reg.unit && reg.amountCents && reg.amountCents > 0) {
    // In reimbursements: reportRef is always blank/empty. Load numbers stay inside notes!
    const reportRef = kind === 'chargeback' ? (reg.reportRef || reg.moneyTransferCode) : undefined;
    return {
      unit: normUnit(reg.unit) || undefined,
      amountCents: reg.amountCents,
      reportRef,
      party,
      note: reg.combinedNote || (kind === 'chargeback' ? 'Charge' : 'Reimbursement'),
    };
  }

  // 2. Fall back to Groq
  const ai = await parseWithGroq(cleanText, kind);
  if (ai && ai.unit && ai.amountCents && ai.amountCents > 0) {
    if (kind === 'reimbursement') ai.reportRef = undefined;
    return ai;
  }

  // 3. Partial fallback if regex found amount or unit and Groq failed
  if (reg.amountCents && reg.amountCents > 0 && reg.unit) {
    const reportRef = kind === 'chargeback' ? (reg.reportRef || reg.moneyTransferCode) : undefined;
    return {
      unit: normUnit(reg.unit) || undefined,
      amountCents: reg.amountCents,
      reportRef,
      party,
      note: reg.combinedNote,
    };
  }

  return null;
}

interface MonitoredTarget {
  kind: Kind | 'test';
  title: string;
  entity: any;
  isTest?: boolean;
}

let tgClient: TelegramClient | null = null;
let lastTelegramError: string | null = null;
let isStartingListener = false;
const monitoredMap = new Map<string, MonitoredTarget>();

export function getTelegramStatus() {
  return {
    connected: Boolean(tgClient && tgClient.connected),
    monitoredChannels: Array.from(monitoredMap.values()).map((m) => m.title),
    monitoredCount: monitoredMap.size,
    lastEntryDate: getLastTelegramEntryDate(),
    lastError: lastTelegramError,
  };
}

export async function disconnectTelegram() {
  if (tgClient) {
    try {
      console.log('[Telegram] Disconnecting MTProto client...');
      await tgClient.disconnect();
    } catch (e) {
      console.error('[Telegram] Disconnect error:', e);
    } finally {
      tgClient = null;
    }
  }
}

/**
 * Ensures MTProto client is connected and listening.
 */
export async function ensureTelegramConnected(): Promise<boolean> {
  if (tgClient && tgClient.connected && monitoredMap.size > 0) {
    return true;
  }
  if (isStartingListener) {
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 400));
      if (tgClient && tgClient.connected && monitoredMap.size > 0) return true;
    }
  }
  try {
    await startTelegramListener();
    return Boolean(tgClient && tgClient.connected);
  } catch (err: any) {
    lastTelegramError = err.message || String(err);
    console.error('[Telegram] ensureTelegramConnected failed:', lastTelegramError);
    return false;
  }
}

/**
 * Processes a single Telegram message and saves to Google Sheets if valid.
 */
async function processMessage(
  message: any,
  targetInfo: MonitoredTarget,
  sendReply = true
): Promise<boolean> {
  const text = message.text?.trim() || '';
  if (!text) return false;

  // Ignore bot's own replies
  if (text.startsWith('✅') || text.startsWith('🧪') || text.startsWith('📢') || text.startsWith('Important🚨')) {
    return false;
  }

  const isTestChannel = Boolean(targetInfo.isTest || targetInfo.kind === 'test');
  let actualKind: Kind;
  if (targetInfo.kind === 'reimbursement') {
    actualKind = 'reimbursement';
  } else if (targetInfo.kind === 'chargeback') {
    actualKind = 'chargeback';
  } else {
    // Test channel keyword check
    const isReimbKeyword = /(?:reimb|reimbursement|detention|layover|lumper|refund|scale|cat\s*scale|def|toll|dry\s*run)/i.test(text);
    const isChargeKeyword = /(?:charge|chargeback|advance|cash\s*advance|deduction|fee|late\s*fee|damage|fine|pm\s*service)/i.test(text);
    if (isReimbKeyword && !isChargeKeyword) {
      actualKind = 'reimbursement';
    } else if (isChargeKeyword && !isReimbKeyword) {
      actualKind = 'chargeback';
    } else {
      actualKind = isReimbKeyword ? 'reimbursement' : 'chargeback';
    }
  }

  const parsed = await parseExpense(text, actualKind);
  if (!parsed || !parsed.unit || !parsed.amountCents) {
    return false;
  }

  // Determine event date from message timestamp
  const msgDate = message.date ? new Date(message.date * 1000).toISOString().slice(0, 10) : todayET();
  const curWeek = weekStartOf(msgDate);
  const amtFmt = (parsed.amountCents / 100).toFixed(2);
  const finalNote = parsed.note;
  const tgRefTag = `[tg:${message.id}]`;

  // Duplicate Check: Check if an entry with identical message ID or (unit, amount, kind, date) already exists
  const s = snapshot();
  const alreadyExists = [...s.latest.values()].some(
    (e) =>
      e.unit === parsed.unit &&
      e.amountCents === parsed.amountCents &&
      e.kind === actualKind &&
      (e.eventDate === msgDate || e.weekStart === curWeek) &&
      (
        (parsed.reportRef && e.sourceRef === parsed.reportRef) ||
        e.note === finalNote ||
        (e.statusNote && e.statusNote.includes(tgRefTag))
      )
  );

  if (alreadyExists) {
    console.log(`[Telegram Catch-Up] Skipping duplicate entry for Unit ${parsed.unit} ($${amtFmt}) [msgId: ${message.id}]`);
    return false;
  }

  // Ensure unit exists in Google Sheets
  const exists = s.units.some((u) => u.unit === parsed.unit) || s.archived.some((a) => a.unit === parsed.unit);
  if (!exists) {
    console.log(`[Telegram] Unit ${parsed.unit} does not exist yet. Auto-registering unit...`);
    await changeUnits((units) => ({
      units: [
        ...units,
        {
          unit: parsed.unit!,
          driver: `Driver (Unit ${parsed.unit})`,
          createdAt: msgDate,
          owner: parsed.party === 'owner' ? 'Owner' : '',
        },
      ],
    }));
  }

  const now = new Date().toISOString();
  const baseStatusNote = isTestChannel
    ? `Test from ${targetInfo.title}`
    : parsed.reportRef
    ? `Ref: ${parsed.reportRef}`
    : 'Telegram Ingestion';
  const fullStatusNote = `${baseStatusNote} ${tgRefTag}`;

  const entry: Entry = {
    id: randomUUID(),
    version: 1,
    savedAt: now,
    savedBy: 'telegram-bot',
    weekStart: curWeek,
    eventDate: msgDate,
    unit: parsed.unit,
    kind: actualKind,
    amountCents: parsed.amountCents,
    note: finalNote,
    status: 'incomplete',
    statusNote: fullStatusNote,
    source: 'telegram',
    sourceRef: parsed.reportRef || '',
    weekReason: '',
    voided: false,
    voidReason: '',
    createdAt: now,
    createdBy: 'telegram-bot',
    party: parsed.party,
  };

  await createEntries([entry]);
  console.log(`[Telegram Ingested SUCCESS]: Unit ${parsed.unit} (${parsed.party}): ${actualKind} $${amtFmt} - "${finalNote}" (${tgRefTag})`);

  // Send confirmation reply in Telegram (for real-time messages only)
  if (sendReply) {
    try {
      const sign = actualKind === 'reimbursement' ? '+' : '−';
      const header = isTestChannel
        ? `🧪 [TEST Ingested to ${actualKind === 'reimbursement' ? 'Reimbursements' : 'Charges'}]`
        : `✅ Recorded in Unit ${parsed.unit} (${parsed.party === 'owner' ? 'Owner' : 'Driver'})`;
      const replyText = `${header}\n🚛 Unit: ${parsed.unit} (${parsed.party === 'owner' ? 'Owner' : 'Driver'})\n💰 ${sign}$${amtFmt}\n📝 ${finalNote}${parsed.reportRef ? `\n📋 Ref: ${parsed.reportRef}` : ''}\n⏳ Status: Incomplete`;
      await tgClient?.sendMessage(targetInfo.entity, {
        message: replyText,
        replyTo: message.id,
      });
    } catch (replyErr) {
      console.error('[Telegram Reply Error]:', replyErr);
    }
  }

  return true;
}

export interface CatchUpOptions {
  fromDate?: string; // YYYY-MM-DD
  days?: number;     // Lookback in days
}

/**
 * Scans past messages sent while server was offline and ingests them chronologically one by one.
 * Automatically goes back to the day changes were last added in Google Sheets if not explicitly specified.
 */
export async function catchUpMissedMessages(options?: CatchUpOptions): Promise<{
  ok: boolean;
  totalProcessed: number;
  newEntries: number;
  fromDate: string;
  channelsChecked: number;
  error?: string;
}> {
  const connected = await ensureTelegramConnected();
  if (!connected || !tgClient) {
    const errMsg = lastTelegramError
      ? `Telegram connection error: ${lastTelegramError}`
      : 'Telegram client could not connect. Please check API_ID, API_HASH, and TELEGRAM_SESSION.';
    return {
      ok: false,
      totalProcessed: 0,
      newEntries: 0,
      fromDate: '',
      channelsChecked: 0,
      error: errMsg,
    };
  }

  if (monitoredMap.size === 0) {
    return {
      ok: false,
      totalProcessed: 0,
      newEntries: 0,
      fromDate: '',
      channelsChecked: 0,
      error: 'No monitored Telegram channels found. Ensure the account belongs to "BUK charges" and "BUK REIMBURSEMENTS".',
    };
  }

  // Determine starting date:
  // 1. Explicit fromDate in options
  // 2. Explicit days back in options
  // 3. Last recorded telegram entry date in Google Sheets (minus 1 day for timezone safety)
  // 4. Default: 7 days ago
  let targetStartDateStr = options?.fromDate;
  if (!targetStartDateStr && options?.days && options.days > 0) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - options.days);
    targetStartDateStr = d.toISOString().slice(0, 10);
  }

  if (!targetStartDateStr) {
    const lastDate = getLastTelegramEntryDate();
    if (lastDate) {
      // Go back 1 day before the last recorded date to account for timezone differences / late posts
      const d = new Date(lastDate + 'T00:00:00.000Z');
      d.setUTCDate(d.getUTCDate() - 1);
      targetStartDateStr = d.toISOString().slice(0, 10);
      console.log(`[Telegram Catch-Up] Last Telegram entry in sheet was on ${lastDate}. Catching up starting from ${targetStartDateStr}...`);
    } else {
      // No telegram entries yet in sheet: look back 7 days
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - 7);
      targetStartDateStr = d.toISOString().slice(0, 10);
      console.log(`[Telegram Catch-Up] No prior Telegram entries found. Defaulting to 7 days lookback: starting from ${targetStartDateStr}...`);
    }
  }

  const targetDateObj = new Date(targetStartDateStr + 'T00:00:00.000Z');
  const sinceTimestamp = Math.floor(targetDateObj.getTime() / 1000);

  const syncState = loadSyncState();
  let newEntries = 0;
  let totalProcessed = 0;

  for (const [idKey, target] of monitoredMap.entries()) {
    try {
      console.log(`[Telegram Catch-Up] Scanning channel "${target.title}" for messages since ${targetStartDateStr}...`);
      const msgsToProcess: any[] = [];
      let offsetId = 0;
      const MAX_CHUNKS = 15; // Up to 1,500 messages per channel

      for (let chunkIdx = 0; chunkIdx < MAX_CHUNKS; chunkIdx++) {
        const getParams: any = { limit: 100 };
        if (offsetId > 0) {
          getParams.offsetId = offsetId;
        }
        const chunk: any = await tgClient.getMessages(target.entity, getParams);
        if (!chunk || chunk.length === 0) break;

        let reachedOlder = false;
        for (const m of chunk) {
          if (!m || !m.date) continue;
          if (m.date >= sinceTimestamp) {
            msgsToProcess.push(m);
          } else {
            reachedOlder = true;
            break;
          }
        }

        if (reachedOlder || chunk.length < 100) {
          break;
        }

        offsetId = chunk[chunk.length - 1].id;
      }

      if (msgsToProcess.length === 0) {
        console.log(`[Telegram Catch-Up] No messages found in "${target.title}" since ${targetStartDateStr}.`);
        continue;
      }

      // Sort strictly in chronological order (oldest first, newest last)
      msgsToProcess.sort((a, b) => a.id - b.id);
      console.log(`[Telegram Catch-Up] Found ${msgsToProcess.length} messages in "${target.title}" since ${targetStartDateStr}. Ingesting one by one...`);

      for (const msg of msgsToProcess) {
        try {
          totalProcessed++;
          const saved = await processMessage(msg, target, false);
          if (saved) {
            newEntries++;
          }
          if (msg.id > (syncState.lastSeenIds[idKey] ?? 0)) {
            syncState.lastSeenIds[idKey] = msg.id;
          }
          // Small pause to prevent hitting rate limits during bulk backfill
          await new Promise((r) => setTimeout(r, 150));
        } catch (msgErr) {
          console.error(`[Telegram Catch-Up] Error processing message ${msg.id} in "${target.title}":`, msgErr);
        }
      }
    } catch (err: any) {
      console.error(`[Telegram Catch-Up Error on "${target.title}"]:`, err);
    }
  }

  saveSyncState(syncState);
  console.log(`[Telegram Catch-Up Finished] Checked ${totalProcessed} messages since ${targetStartDateStr}. Backfilled ${newEntries} new entries.`);
  return {
    ok: true,
    totalProcessed,
    newEntries,
    fromDate: targetStartDateStr,
    channelsChecked: monitoredMap.size,
  };
}

/**
 * Starts the Telegram MTProto listener in the background with automatic startup catch-up.
 */
export async function startTelegramListener() {
  if (isStartingListener) return;
  isStartingListener = true;

  const apiId = Number(process.env.API_ID);
  const apiHash = String(process.env.API_HASH ?? '');
  const sessionStr = String(process.env.TELEGRAM_SESSION ?? '');

  if (!apiId || !apiHash || !sessionStr) {
    lastTelegramError = 'API_ID, API_HASH or TELEGRAM_SESSION is missing in environment variables.';
    console.warn(`[Telegram] ${lastTelegramError}`);
    isStartingListener = false;
    return;
  }

  try {
    if (tgClient) {
      try {
        await tgClient.disconnect();
      } catch {}
      tgClient = null;
    }

    tgClient = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, {
      connectionRetries: 5,
    });

    console.log('[Telegram] Connecting MTProto client...');
    await tgClient.connect();
    lastTelegramError = null;

    const dialogs = await tgClient.getDialogs({ limit: 200 });
    const chargesDialog = dialogs.find((d) => /buk\s*charges/i.test(d.title || d.name || ''));
    const reimbDialog = dialogs.find((d) => /buk\s*reimbursements/i.test(d.title || d.name || ''));
    const notesDialog = dialogs.find((d) => /^(notes|test)$/i.test((d.title || d.name || '').trim()));
    const chargesTestDialog = dialogs.find((d) => /^charges\s*test$/i.test((d.title || d.name || '').trim()));
    const reimbTestDialog = dialogs.find((d) => /^reimbursements?\s*test$/i.test((d.title || d.name || '').trim()));

    if (!chargesDialog && !reimbDialog && !notesDialog && !chargesTestDialog && !reimbTestDialog) {
      lastTelegramError = 'Could not find any monitored channels in Telegram dialogs.';
      console.warn(`[Telegram] ${lastTelegramError}`);
      console.log('Available dialogs:', dialogs.map((d) => d.title || d.name).slice(0, 20));
      isStartingListener = false;
      return;
    }

    monitoredMap.clear();

    if (chargesDialog && chargesDialog.id) {
      const idKey = chargesDialog.id.toString();
      const title = chargesDialog.title || 'BUK charges';
      monitoredMap.set(idKey, { kind: 'chargeback', title, entity: chargesDialog.entity, isTest: false });
      console.log(`[Telegram] Monitored: "${title}" (ID: ${idKey}) → Charges`);
    }

    if (reimbDialog && reimbDialog.id) {
      const idKey = reimbDialog.id.toString();
      const title = reimbDialog.title || 'BUK REIMBURSEMENTS';
      monitoredMap.set(idKey, { kind: 'reimbursement', title, entity: reimbDialog.entity, isTest: false });
      console.log(`[Telegram] Monitored: "${title}" (ID: ${idKey}) → Reimbursements`);
    }

    if (chargesTestDialog && chargesTestDialog.id) {
      const idKey = chargesTestDialog.id.toString();
      const title = chargesTestDialog.title || 'charges test';
      monitoredMap.set(idKey, { kind: 'chargeback', title, entity: chargesTestDialog.entity, isTest: true });
      console.log(`[Telegram] Monitored: "${title}" (ID: ${idKey}) → Charges Test Channel`);
    }

    if (reimbTestDialog && reimbTestDialog.id) {
      const idKey = reimbTestDialog.id.toString();
      const title = reimbTestDialog.title || 'reimbursements test';
      monitoredMap.set(idKey, { kind: 'reimbursement', title, entity: reimbTestDialog.entity, isTest: true });
      console.log(`[Telegram] Monitored: "${title}" (ID: ${idKey}) → Reimbursements Test Channel`);
    }

    if (notesDialog && notesDialog.id) {
      const idKey = notesDialog.id.toString();
      const title = notesDialog.title || 'notes';
      monitoredMap.set(idKey, { kind: 'test', title, entity: notesDialog.entity, isTest: true });
      console.log(`[Telegram] Monitored: "${title}" (ID: ${idKey}) → Testing Channel (Charges & Reimbursements)`);
    }

    // 1. Run automatic catch-up: goes back to the day changes stopped and backfills one by one
    await catchUpMissedMessages().catch((e) => console.error('[Telegram Catch-Up Failed on startup]', e));

    // 2. Add real-time event listener for live incoming messages
    tgClient.addEventHandler(async (event: any) => {
      const message = event.message;
      if (!message || !message.text) return;

      const peerIdStr = message.peerId?.channelId?.toString()
        ? `-100${message.peerId.channelId}`
        : message.peerId?.chatId?.toString()
        ? `-${message.peerId.chatId}`
        : message.peerId?.userId?.toString() ?? '';

      // Match against monitored chats
      let targetInfo: MonitoredTarget | undefined;
      let matchedIdKey: string | undefined;
      for (const [key, val] of monitoredMap.entries()) {
        if (key === peerIdStr || key.endsWith(message.peerId?.channelId?.toString() || 'NOMATCH') || key.endsWith(message.peerId?.chatId?.toString() || 'NOMATCH')) {
          targetInfo = val;
          matchedIdKey = key;
          break;
        }
      }

      if (!targetInfo || !matchedIdKey) return;

      const text = message.text.trim();
      console.log(`\n[Telegram Incoming from "${targetInfo.title}"]:`, text.replace(/\n/g, ' '));

      try {
        await processMessage(message, targetInfo, true);

        // Update sync state with latest ID
        const syncState = loadSyncState();
        syncState.lastSeenIds[matchedIdKey] = Math.max(syncState.lastSeenIds[matchedIdKey] ?? 0, message.id);
        saveSyncState(syncState);
      } catch (ingestErr) {
        console.error('[Telegram Ingestion Failed]:', ingestErr);
      }
    }, new NewMessage({}));

    console.log('[Telegram] Live listener active and listening for new messages!');
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (msg.includes('AUTH_KEY_DUPLICATED') || err?.code === 406) {
      lastTelegramError = 'AUTH_KEY_DUPLICATED: Session is revoked or used by another instance. Please generate a new session with npm run tg-auth.';
      console.error('CRITICAL [Telegram]:', lastTelegramError);
    } else {
      lastTelegramError = msg;
      console.error('[Telegram] Failed to start listener:', err);
    }
    if (tgClient) {
      try {
        await tgClient.disconnect();
      } catch {}
      tgClient = null;
    }
  } finally {
    isStartingListener = false;
  }
}

