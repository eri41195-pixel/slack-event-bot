const fs = require("fs");
const path = require("path");
const { App, ExpressReceiver } = require("@slack/bolt");

// ====== Config ======
const PORT = process.env.PORT || 3000;
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;

if (!process.env.SLACK_BOT_TOKEN) {
  console.error("❌ SLACK_BOT_TOKEN is missing");
}
if (!process.env.SLACK_SIGNING_SECRET) {
  console.error("❌ SLACK_SIGNING_SECRET is missing");
}

const DATA_FILE = path.join(__dirname, "events.json");
const TZ = "Asia/Tokyo";

// ====== Slack (Bolt) ======
const receiver = new ExpressReceiver({receiver.app.use((req, _res, next) => {
  console.log("REQ", req.method, req.path);
  next();
});

  signingSecret: process.env.SLACK_SIGNING_SECRET,
  // Slash Commands の Request URL を .../slack/commands にしている前提
  endpoints: {
    commands: "/slack/commands",
  },
});

receiver.app.get("/health", (_req, res) => res.status(200).send("ok"));

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

// ====== Utilities ======
function ensureDataFile() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2), "utf-8");
  }
}

function loadEvents() {
  ensureDataFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error("Failed to read events.json:", e);
    return [];
  }
}

function saveEvents(events) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(events, null, 2), "utf-8");
}

function formatJst(isoString) {
  const d = new Date(isoString);
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

// JSTの「いま」を "YYYY-MM-DD HH:mm" で返す（サーバーTZに依存しない）
function nowKeyJst() {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

// 入力: YYYY-MM-DD + HH:mm を JST として ISO にする（サーバーTZに依存しない）
function parseJstToIso(dateStr, timeStr) {
  // 例: 2026-01-12 20:27
  // JST(+09:00)固定として ISO文字列化
  return `${dateStr}T${timeStr}:00+09:00`;
}

function nextId(events) {
  const max = events.reduce((m, e) => Math.max(m, Number(e.id) || 0), 0);
  return max + 1;
}

function helpText() {
  return [
    "使い方:",
    "• /event add YYYY-MM-DD HH:mm タイトル",
    "• /event list",
    "• /event remove ID",
    "",
    "例:",
    "• /event add 2026-01-12 20:27 Render自動投稿テスト",
    "• /event remove 3",
  ].join("\n");
}

// ====== Slash Command: /event ======
app.command("/event", async ({ command, ack, respond }) => {
  // Slackの3秒制限があるので、先に必ずackする
  await ack();

  const text = (command.text || "").trim();
  if (!text) {
    await respond(helpText());
    return;
  }

  const [sub, ...rest] = text.split(/\s+/);

  if (sub === "add") {
    // /event add YYYY-MM-DD HH:mm タイトル...
    if (rest.length < 3) {
      await respond("❌ 形式が違います。\n" + helpText());
      return;
    }
    const dateStr = rest[0];
    const timeStr = rest[1];
    const title = rest.slice(2).join(" ");

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !/^\d{2}:\d{2}$/.test(timeStr)) {
      await respond("❌ 日付/時刻の形式が違います（YYYY-MM-DD / HH:mm）。\n" + helpText());
      return;
    }

    const isoJst = parseJstToIso(dateStr, timeStr);

    const events = loadEvents();
    const id = nextId(events);

    events.push({
      id,
      isoJst,
      title,
      notified: false,
    });
    saveEvents(events);

    await respond(`登録しました ✅ ID=${id}\n${formatJst(isoJst)}  ${title}`);
    return;
  }

  if (sub === "list") {
    const events = loadEvents().slice().sort((a, b) => (a.isoJst > b.isoJst ? 1 : -1));
    if (events.length === 0) {
      await respond("イベントはありません。");
      return;
    }

    const lines = ["イベント一覧（最大50件）"];
    for (const e of events.slice(0, 50)) {
      lines.push(`• [${e.id}] ${formatJst(e.isoJst)}  ${e.title}  ${e.notified ? "✅" : "⏳"}`);
    }
    await respond(lines.join("\n"));
    return;
  }

  if (sub === "remove" || sub === "delete") {
    const idStr = rest[0];
    const id = Number(idStr);
    if (!idStr || Number.isNaN(id)) {
      await respond("❌ remove の形式が違います。\n例: /event remove 3");
      return;
    }
    const events = loadEvents();
    const before = events.length;
    const afterEvents = events.filter((e) => Number(e.id) !== id);
    saveEvents(afterEvents);

    if (afterEvents.length === before) {
      await respond(`⚠️ ID=${id} は見つかりませんでした。`);
    } else {
      await respond(`削除しました ✅ ID=${id}`);
    }
    return;
  }

  await respond("❓ サブコマンドが分かりません。\n" + helpText());
});

// ====== Reminder loop ======
async function tryPostReminder(event) {
  const msg = `⏰ リマインド\n${formatJst(event.isoJst)}  ${event.title}`;

  if (!TARGET_CHANNEL_ID) {
    console.warn("⚠️ TARGET_CHANNEL_ID is not set. Auto reminder is disabled.");
    return { ok: false, error: "TARGET_CHANNEL_ID not set" };
  }

  try {
    await app.client.chat.postMessage({
      channel: TARGET_CHANNEL_ID,
      text: msg,
    });
    console.log("Posted reminder:", msg);
    return { ok: true };
  } catch (e) {
    console.error("Failed to post reminder:", e?.data?.error || e);
    return { ok: false, error: e?.data?.error || String(e) };
  }
}

function eventKeyJst(isoJst) {
  // ISO(固定+09:00)を Date にして、JST表示キーにする
  return formatJst(isoJst);
}

async function tick() {
  const nowKey = nowKeyJst(); // "YYYY-MM-DD HH:mm" JST
  const events = loadEvents();

  let changed = false;

  for (const e of events) {
    if (e.notified) continue;
    const ek = eventKeyJst(e.isoJst);
    if (ek === nowKey) {
      const r = await tryPostReminder(e);
      if (r.ok) {
        e.notified = true;
        changed = true;
      }
    }
  }

  if (changed) saveEvents(events);
}

// 30秒ごとにチェック（分単位運用なら十分）
setInterval(() => {
  tick().catch((e) => console.error("tick error:", e));
}, 30 * 1000);

// ====== Start ======
(async () => {
  ensureDataFile();
  await app.start(PORT);
  console.log(`⚡️ Bot is running on port ${PORT}`);
})();
