require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { App, ExpressReceiver } = require("@slack/bolt");

// ====== Config ======
const PORT = process.env.PORT || 3000;
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;
const TZ = "Asia/Tokyo";
const DATA_FILE = path.join(__dirname, "events.json");

// ====== Slack (Bolt) ======
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: {
    commands: "/slack/commands",
  },
});

// ✅ ここは receiver 作成の「後」に書く（構文エラー防止）
receiver.app.use((req, _res, next) => {
  console.log("REQ", req.method, req.path);
  next();
});

// health check
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

  const get = (type) => {
    const p = parts.find((x) => x.type === type);
    return p ? p.value : "";
  };

  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

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

  const get = (type) => {
    const p = parts.find((x) => x.type === type);
    return p ? p.value : "";
  };

  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

function parseJstToIso(dateStr, timeStr) {
  // JST(+09:00)固定。サーバーのTZに依存しない
  return `${dateStr}T${timeStr}:00+09:00`;
}

function nextId(events) {
  let max = 0;
  for (const e of events) {
    const n = Number(e.id);
    if (!Number.isNaN(n)) max = Math.max(max, n);
  }
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
  // Slackは3秒制限があるので、先にack
  await ack();

  const text = (command.text || "").trim();
  if (!text) {
    await respond(helpText());
    return;
  }

  const tokens = text.split(/\s+/);
  const sub = tokens[0];

  if (sub === "add") {
    if (tokens.length < 4) {
      await respond("❌ 形式が違います。\n" + helpText());
      return;
    }

    const dateStr = tokens[1];
    const timeStr = tokens[2];
    const title = tokens.slice(3).join(" ");

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
    const events = loadEvents()
      .slice()
      .sort((a, b) => (a.isoJst > b.isoJst ? 1 : -1));

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
    if (tokens.length < 2) {
      await respond("❌ remove の形式が違います。\n例: /event remove 3");
      return;
    }

    const id = Number(tokens[1]);
    if (Number.isNaN(id)) {
      await respond("❌ ID は数字で指定してください。\n例: /event remove 3");
      return;
    }

    const events = loadEvents();
    const before = events.length;
    const after = events.filter((e) => Number(e.id) !== id);
    saveEvents(after);

    if (after.length === before) {
      await respond(`⚠️ ID=${id} は見つかりませんでした。`);
    } else {
      await respond(`削除しました ✅ ID=${id}`);
    }
    return;
  }

  await respond("❓ サブコマンドが分かりません。\n" + helpText());
});

// ====== Reminder loop ======
async function postReminder(event) {
  if (!TARGET_CHANNEL_ID) {
    console.warn("⚠️ TARGET_CHANNEL_ID is not set. Auto reminder is disabled.");
    return { ok: false, error: "TARGET_CHANNEL_ID not set" };
  }

  const msg = `⏰ リマインド\n${formatJst(event.isoJst)}  ${event.title}`;

  try {
    await app.client.chat.postMessage({
      channel: TARGET_CHANNEL_ID,
      text: msg,
    });
    console.log("Posted reminder:", msg);
    return { ok: true };
  } catch (e) {
    const err = e && e.data && e.data.error ? e.data.error : String(e);
    console.error("Failed to post reminder:", err);
    return { ok: false, error: err };
  }
}

async function tick() {
  const nowKey = nowKeyJst(); // "YYYY-MM-DD HH:mm" (JST)
  const events = loadEvents();
  let changed = false;

  for (const e of events) {
    if (e.notified) continue;

    const ek = formatJst(e.isoJst); // JST固定の "YYYY-MM-DD HH:mm"
    if (ek === nowKey) {
      const r = await postReminder(e);
      if (r.ok) {
        e.notified = true;
        changed = true;
      }
    }
  }

  if (changed) saveEvents(events);
}

// 30秒ごとにチェック（分単位運用OK）
setInterval(() => {
  tick().catch((e) => console.error("tick error:", e));
}, 30 * 1000);

// ====== Start ======
(async () => {
  ensureDataFile();
  await app.start(PORT);
  console.log(`⚡️ Bot is running on port ${PORT}`);
})();
