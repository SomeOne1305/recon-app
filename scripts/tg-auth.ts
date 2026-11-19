import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Load .env
try {
  process.loadEnvFile('.env');
} catch {}

const apiId = Number(process.env.API_ID);
const apiHash = String(process.env.API_HASH ?? '');
const PENDING_FILE = path.resolve('.tg-session-pending.json');

async function sendCode(phoneNumber: string) {
  if (!apiId || !apiHash) {
    throw new Error('API_ID and API_HASH must be set in .env');
  }

  const session = new StringSession('');
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });

  console.log(`Connecting to Telegram MTProto...`);
  await client.connect();

  console.log(`Sending code request to ${phoneNumber}...`);
  const result = await client.sendCode(
    { apiId, apiHash },
    phoneNumber
  );

  const interimSession = client.session.save() as unknown as string;

  fs.writeFileSync(
    PENDING_FILE,
    JSON.stringify(
      {
        phoneNumber,
        phoneCodeHash: result.phoneCodeHash,
        isCodeViaApp: result.isCodeViaApp,
        session: interimSession,
        sentAt: new Date().toISOString(),
      },
      null,
      2
    )
  );

  console.log(`Code successfully dispatched by Telegram!`);
  console.log(`Delivery method: ${result.isCodeViaApp ? 'Telegram in-app notification' : 'SMS'}`);
  await client.disconnect();
}

async function verifyCode(code: string, password?: string) {
  if (!fs.existsSync(PENDING_FILE)) {
    throw new Error('No pending login request found. Run send-code first.');
  }

  const pending = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf-8'));
  const session = new StringSession(pending.session);
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.connect();

  console.log(`Submitting code for ${pending.phoneNumber}...`);
  let user: any;
  try {
    const res = await client.invoke(
      new Api.auth.SignIn({
        phoneNumber: pending.phoneNumber,
        phoneCodeHash: pending.phoneCodeHash,
        phoneCode: code.trim(),
      })
    );
    if ('user' in res) {
      user = res.user;
    }
  } catch (err: any) {
    if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
      if (!password) {
        console.error('2FA_REQUIRED: This Telegram account has Two-Factor Authentication (2FA) enabled.');
        console.error('Please provide your 2FA password as well.');
        process.exit(2);
      }
      console.log(`Submitting 2FA password...`);
      user = await (client as any).signInWithPassword(
        { apiId, apiHash },
        { password: async () => password }
      );
    } else {
      throw err;
    }
  }

  const finalSession = client.session.save() as unknown as string;

  // Save TELEGRAM_SESSION into .env
  const envPath = path.resolve('.env');
  let envContent = fs.readFileSync(envPath, 'utf-8');
  if (envContent.includes('TELEGRAM_SESSION=')) {
    envContent = envContent.replace(/TELEGRAM_SESSION=.*/g, `TELEGRAM_SESSION=${finalSession}`);
  } else {
    envContent += `\nTELEGRAM_SESSION=${finalSession}\n`;
  }
  fs.writeFileSync(envPath, envContent);

  // Clean up pending file
  try {
    fs.unlinkSync(PENDING_FILE);
  } catch {}

  const displayName = user?.firstName ? `${user.firstName} ${user.lastName ?? ''}`.trim() : user?.username ?? pending.phoneNumber;
  console.log(`SUCCESS: Logged in as ${displayName}!`);
  console.log(`Session string successfully saved to .env as TELEGRAM_SESSION.`);
  await client.disconnect();
}

async function main() {
  const [,, cmd, arg1, arg2] = process.argv;
  if (cmd === 'send-code') {
    const phone = arg1 || '+998910131630';
    await sendCode(phone);
  } else if (cmd === 'verify') {
    if (!arg1) throw new Error('Usage: verify <code> [2fa-password]');
    await verifyCode(arg1, arg2);
  } else {
    console.log('Usage:');
    console.log('  npm run tg-auth send-code [phoneNumber]');
    console.log('  npm run tg-auth verify <code> [password]');
  }
}

main().catch(err => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
