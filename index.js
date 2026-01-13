require("dotenv").config();
const { WebClient } = require("@slack/web-api");
const { GoogleSpreadsheet } = require("google-spreadsheet");

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME;
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;

function getNowJst() {
  const now = new Date();
  return new Date(now.getTime() + 9 * 60 * 60 * 1000);
}

function getTomorrowDateString(now) {
  const t = new Date(now);
  t.setDate(t.getDate() + 1);
  return t.toISOString().slice(0, 10);
}

async function run() {
  console.log("⏰ Cron Job started");

  const doc = new GoogleSpreadsheet(SPREADSHEET_ID);
  await doc.useServiceAccountAuth(
    JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
  );
  await doc.loadInfo();

  const sheet = doc.sheetsByTitle[SHEET_NAME];
  const rows = await sheet.getRows();

  const now = getNowJst();
  const nowDate = now.toISOString().slice(0, 10);
  const nowTime = now.toTimeString().slice(0, 5);
  const tomorrowDate = getTomorrowDateString(now);

  for (const row of rows) {
    if (row["配信有効"] !== "TRUE") continue;

    const eventDate = row["日付"];
    const eventTime = row["開始時刻"];

    // 前日20:00固定
    if (
      row["前日送信済み"] !== "TRUE" &&
      eventDate === tomorrowDate &&
      nowTime === "20:00"
    ) {
      await slack.chat.postMessage({
        channel: TARGET_CHANNEL_ID,
        text:
          `📢 明日 ${eventTime}〜 ${row["イベント名"]}\n` +
          `${row["ひとこと"]}\n` +
          `${row["Zoomリンク"]}`
      });
      row["前日送信済み"] = "TRUE";
      await row.save();
      console.log("✅ 前日20:00通知送信");
    }

    // 当日1時間前
    if (
      row["1時間前送信済み"] !== "TRUE" &&
      eventDate === nowDate &&
      eventTime === nowTime
    ) {
      await slack.chat.postMessage({
        channel: TARGET_CHANNEL_ID,
        text:
          `⏰ 本日このあと ${eventTime}〜 ${row["イベント名"]}\n` +
          `${row["ひとこと"]}\n` +
          `${row["Zoomリンク"]}`
      });
      row["1時間前送信済み"] = "TRUE";
      await row.save();
      console.log("✅ 当日通知送信");
    }
  }

  console.log("🏁 Cron Job finished");
}

run().catch(console.error);
