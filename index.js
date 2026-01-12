require("dotenv").config();
const { App, ExpressReceiver } = require("@slack/bolt");
const fs = require("fs");
const path = require("path");

const STORE_PATH = path.join(__dirname, "events.json");
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;

function loadEvents() {
  try { return JSON.parse(fs.readFileSync(STORE_PATH, "utf8")); }
  catch { return []; }
}
function saveEvents(events) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(events, null, 2), "utf8");
}
function nextId(events) {
  return events.length ? Math.max(...events.map(e => e.id)) + 1 : 1;
}

// Parse: YYYY-MM-DD HH:mm title...
function parseAddArgs(text) {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 3) return null;

  const dateStr = parts[0];
  const timeStr = parts[1]; // HH:mm
  const title = parts.slice(2).join(" ").trim();
  if (!title) return null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  if (!/^\d{2}:\d{2}$/.test(timeStr)) return null;

  const [hh, mm] = timeStr.split(":").map(Number);
  if (!Number.isInteger(hh) || hh < 0 || hh > 23) return null;
  if (!Number.isInteger(mm) || mm < 0 || mm > 59) return null;

  const isoJst = `${dateStr}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+09:00`;
  const d = new Date(isoJst);
  if (Number.isNaN(d.getTime())) return null;

  return { isoJst, title };
}

function formatJst(isoJst) {
  const d = new Date(isoJst);
  const yyyy = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mo}-${da} ${hh}:${mm}`;
}

// now key: yyyy-mm-dd HH:mm in JST
function nowKeyJst() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(now);

  const get = (type) => parts.find(p => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: { commands: "/slack/commands" },
});
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

app.command("/event", async ({ command, ack, respond }) => {
  await ack();

  const text = (command.text || "").trim();
  if (!text) {
    await respond({
      response_type: "ephemeral",
      text:
        "使い方:\n" +
        "• /event add YYYY-MM-DD HH:mm タイトル\n" +
        "• /event list\n" +
        "• /event del ID\n" +
        "例）/event add 2026-01-12 09:30 朝活ミーティング",
    });
    return;
  }

  const [sub, ...rest] = text.split(/\s+/);
  const restText = rest.join(" ").trim();

  if (sub === "add") {
    const parsed = parseAddArgs(restText);
    if (!parsed) {
      await respond({ response_type: "ephemeral", text: "形式: /event add 2026-01-12 09:30 朝活ミーティング" });
      return;
    }

    const events = loadEvents();
    const id = nextId(events);
    events.push({ id, isoJst: parsed.isoJst, title: parsed.title, notified: false });
    events.sort((a, b) => new Date(a.isoJst) - new Date(b.isoJst));
    saveEvents(events);

    await respond({
      response_type: "ephemeral",
      text: `登録しました ✅  ID=${id}\n${formatJst(parsed.isoJst)}  ${parsed.title}`,
    });
    return;
  }

  if (sub === "list") {
    const events = loadEvents().sort((a, b) => new Date(a.isoJst) - new Date(b.isoJst));
    if (events.length === 0) {
      await respond({ response_type: "ephemeral", text: "登録されているイベントはありません。" });
      return;
    }

    const lines = events.slice(0, 50).map(e => {
      const mark = e.notified ? "✅" : "⏳";
      return `• [${e.id}] ${formatJst(e.isoJst)}  ${e.title}  ${mark}`;
    });
    await respond({ response_type: "ephemeral", text: `イベント一覧（最大50件）\n${lines.join("\n")}` });
    return;
  }

  if (sub === "del") {
    const id = Number(rest[0]);
    if (!Number.isInteger(id)) {
      await respond({ response_type: "ephemeral", text: "例: /event del 1" });
      return;
    }

    const events = loadEvents();
    const filtered = events.filter(e => e.id !== id);
    if (filtered.length === events.length) {
      await respond({ response_type: "ephemeral", text: `ID=${id} は見つかりませんでした。` });
      return;
    }

    saveEvents(filtered);
    await respond({ response_type: "ephemeral", text: `削除しました ✅  ID=${id}` });
    return;
  }

  await respond({ response_type: "ephemeral", text: "不明なコマンドです。/event（引数なし）で使い方が出ます。" });
});

async function tick() {
  if (!TARGET_CHANNEL_ID) {
    console.log("⚠️ TARGET_CHANNEL_ID is not set. Auto reminder is disabled.");
    return;
  }

  const nowKey = nowKeyJst(); // yyyy-mm-dd HH:mm (JST)
  const events = loadEvents();
  let changed = false;

  for (const e of events) {
    if (e.notified) continue;

    const ek = formatJst(e.isoJst); // yyyy-mm-dd HH:mm
    if (ek === nowKey) {
      const msg = `⏰ リマインド\n${formatJst(e.isoJst)}  ${e.title}`;

      try {
        await app.client.chat.postMessage({
          channel: TARGET_CHANNEL_ID,
          text: msg,
        });
        e.notified = true;
        changed = true;
        console.log("Posted reminder:", msg);
      } catch (err) {
        console.error("Failed to post reminder:", err);
      }
    }
  }

  if (changed) saveEvents(events);
}

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log("⚡️ Bot is running on port", process.env.PORT || 3000);

  await tick();
  setInterval(tick, 30 * 1000);
})();
