# Reconciliation App — Slice 3

## What's New in Slice 3
1. **Escrow tab (per unit)**: enter the total once, pick the number of weeks. The total is split equally (leftover cents on the last week). Each Monday the app creates that week's payment row automatically (Pending). Mark it Paid, or Held back with a note. The unit page shows the full schedule: which weeks were paid, pending, held back or still scheduled.
2. **Charge from escrow**: one click on an unpaid chargeback (**From escrow**) or the **Charge from escrow** button for any other amount + note. It reduces the escrow that is still held.
3. **Termination window**: unpaid chargebacks are taken from escrow automatically (oldest first), you add damage charges (amount + note each, or skip), the rest of the escrow is refunded and anything escrow cannot cover is shown as still owed. All settlement rows land in **next week**, the plan closes and the unit is archived.
4. **Watchlist**: Yellow / Red zones for drivers with big or repeated charges (tab + badge, pills in the lists, banner on the unit). Limits are in `.env` (ZONE_*).
5. **Copy notes**: every row has a Copy button for its note, every card has **Copy note**. Cards 3 and 4 (Escrow, Charge upon leaving) have amount copy too (keys 1, 2, 3, 4).
6. **Weeks fixes**: no gaps in the weeks list, future weeks are labelled Upcoming, and weekly escrow rows are created automatically when a new week arrives (checked every 15 seconds, and caught up if the server was off).

## Google Sheet changes in Slice 3
- New tab `escrow_plans` (the app creates it and writes the header for you if it is missing).
- `entries` tab: no new columns. New values appear in `kind` (`escrow`, `escrow_charge`, `leaving_charge`) and `source` (`system`).

## What's New in Slice 2
1. **Embedded Login & SaaS UI**: Replaces browser Basic Auth popups with a clean dark-mode login screen, improved spacing, typography, status badges, and table hierarchy.
2. **Unit & Driver Lifecycle**: Full Add, Rename, Delete, and **Terminate / Archive** workflow (`archive_units` tab) that preserves lifetime financial records without cluttering active dispatch.
3. **Inline Entry Editing & Operational Statuses**: Bulk paste removed in favor of structured inline editing (`Done`, `Incomplete`, `Issue`) with mandatory issue notes and plain numeric display (no `$` clutter).
4. **AI / Telegram Ingestion Ready**: Clean JSON API seam (`POST /api/entries` and `POST /api/ingest/entries` with `x-api-key` support) routed through deterministic `checkEntry()` validation.

## Google Sheet Setup
Create a Google Sheet with three exact lowercase tabs:
- `units`
- `archive_units`
- `entries`

*(Note: If upgrading from Slice 1, clear the old `entries` tab and delete the unused `voids` tab. The app writes the exact headers on startup.)*

## Run Locally
1. Share the Google Sheet with your service account email as **Editor**.
2. Copy `.env.example` to `.env` and fill in `SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `APP_USERS`, and `SESSION_SECRET` (must be 32+ characters).
3. Run `npm install && npm run dev` and open `http://localhost:3000`.

## Telegram Ingestion & Catch-Up

1. **Automatic Startup Catch-Up**: Whenever the server starts up (e.g. after Render spins up from sleep), the app queries Google Sheets for the date of the last recorded Telegram entry and automatically backfills all missed messages from monitored channels one by one in chronological order.
2. **Manual Sync**: Click **🔄 Sync Telegram** in the top navigation bar at any time to run catch-up and view live ingestion stats.
3. **Telegram Status**: Click the **● TG** badge in the header to view live MTProto connection state, monitored channel names, and error details.
4. **Re-authenticating Telegram**:
   ```bash
   npm run tg-auth send-code +998910131630
   npm run tg-auth verify <code> [2fa_password]
   ```
   Copy the generated `TELEGRAM_SESSION` from `.env` to Render Environment Variables.
5. **Keep Render Awake**: Render Free services sleep after 15 minutes of inactivity. Set up a free monitor (e.g., [UptimeRobot](https://uptimerobot.com)) to ping `https://your-app.onrender.com/api/health` every 10 minutes to keep the live listener running 24/7. Even if sleeping, waking the server will automatically catch up all missed messages!
