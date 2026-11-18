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
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
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

    const data: any = await res.json();
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
const monitoredMap = new Map<string, MonitoredTarget>();

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
  const finalNote = parsed.note; // Pure clean note without [TEST] prefix

  // Duplicate Check: Check if an entry with identical unit, amount, kind and date already exists
  const s = snapshot();
  const alreadyExists = [...s.latest.values()].some(
    (e) =>
      !e.voided &&
      e.unit === parsed.unit &&
      e.amountCents === parsed.amountCents &&
      e.kind === actualKind &&
      (e.eventDate === msgDate || e.weekStart === curWeek) &&
      (e.sourceRef === (parsed.reportRef || '') || e.note === finalNote)
  );

  if (alreadyExists) {
    console.log(`[Telegram Catch-Up] Skipping duplicate entry for Unit ${parsed.unit} ($${amtFmt})`);
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
    statusNote: isTestChannel ? `Test from ${targetInfo.title}` : parsed.reportRef ? `Ref: ${parsed.reportRef}` : 'Telegram Ingestion',
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
  console.log(`[Telegram Ingested SUCCESS]: Unit ${parsed.unit} (${parsed.party}): ${actualKind} $${amtFmt} - "${finalNote}"`);

  // Send confirmation reply in Telegram (for real-time messages)
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

/**
 * Scans past messages sent while server was offline and ingests them.
 */
export async function catchUpMissedMessages(): Promise<{ totalProcessed: number; newEntries: number }> {
  if (!tgClient) return { totalProcessed: 0, newEntries: 0 };
  const syncState = loadSyncState();
  let newEntries = 0;
  let totalProcessed = 0;

  for (const [idKey, target] of monitoredMap.entries()) {
    try {
      const lastSeenId = syncState.lastSeenIds[idKey] ?? 0;
      let msgs: any[] = [];

      if (lastSeenId > 0) {
        // Fetch new messages since lastSeenId
        msgs = await tgClient.getMessages(target.entity, {
          minId: lastSeenId,
          limit: 100,
          reverse: true, // chronological order
        });
      } else {
        // First run on this channel: seed lastSeenId with the newest message
        const newest = await tgClient.getMessages(target.entity, { limit: 1 });
        if (newest?.[0]?.id) {
          syncState.lastSeenIds[idKey] = newest[0].id;
        }
        continue;
      }

      if (msgs.length > 0) {
        console.log(`[Telegram Catch-Up] Found ${msgs.length} messages in "${target.title}" since last run.`);
        for (const msg of msgs) {
          totalProcessed++;
          const saved = await processMessage(msg, target, false);
          if (saved) newEntries++;
          if (msg.id > (syncState.lastSeenIds[idKey] ?? 0)) {
            syncState.lastSeenIds[idKey] = msg.id;
          }
        }
      }
    } catch (err) {
      console.error(`[Telegram Catch-Up Error on "${target.title}"]:`, err);
    }
  }

  saveSyncState(syncState);
  if (newEntries > 0) {
    console.log(`[Telegram Catch-Up Finished] Successfully backfilled ${newEntries} new entries.`);
  }
  return { totalProcessed, newEntries };
}

/**
 * Starts the Telegram MTProto listener in the background with automatic startup catch-up.
 */
export async function startTelegramListener() {
  const apiId = Number(process.env.API_ID);
  const apiHash = String(process.env.API_HASH ?? '');
  const sessionStr = String(process.env.TELEGRAM_SESSION ?? '');

  if (!apiId || !apiHash || !sessionStr) {
    console.log('[Telegram] Listener not started: API_ID, API_HASH or TELEGRAM_SESSION is missing.');
    return;
  }

  try {
    tgClient = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, {
      connectionRetries: 5,
    });

    console.log('[Telegram] Connecting MTProto client...');
    await tgClient.connect();

    const dialogs = await tgClient.getDialogs({ limit: 100 });
    const chargesDialog = dialogs.find((d) => /buk\s*charges/i.test(d.title || d.name || ''));
    const reimbDialog = dialogs.find((d) => /buk\s*reimbursements/i.test(d.title || d.name || ''));
    const notesDialog = dialogs.find((d) => /^(notes|test)$/i.test((d.title || d.name || '').trim()));
    const chargesTestDialog = dialogs.find((d) => /^charges\s*test$/i.test((d.title || d.name || '').trim()));
    const reimbTestDialog = dialogs.find((d) => /^reimbursements?\s*test$/i.test((d.title || d.name || '').trim()));

    if (!chargesDialog && !reimbDialog && !notesDialog && !chargesTestDialog && !reimbTestDialog) {
      console.warn('[Telegram] Could not find any monitored channels in dialogs.');
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

    // 1. Run automatic catch-up for any messages missed while the server was offline
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
  } catch (err) {
    console.error('[Telegram] Failed to start listener:', err);
  }
}
