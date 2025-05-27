const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config();

// Step 1: Decode base64 env var and write credentials.json before anything else
const base64Creds = process.env.GOOGLE_CREDENTIALS_BASE64;
if (base64Creds) {
  const buff = Buffer.from(base64Creds, 'base64');
  fs.writeFileSync('./credentials.json', buff);
  console.log('✅ credentials.json file created from base64 env var.');
} else {
  console.error('❌ Error: GOOGLE_CREDENTIALS_BASE64 env var is not set');
  process.exit(1); // Stop app if credentials missing
}

// Now continue with the rest of your imports and app code
const express = require("express");
const { google } = require("googleapis");
const cron = require("node-cron");
const twilio = require("twilio");
const moment = require("moment");

// ... rest of your code continues as before


const app = express();
const port = process.env.PORT || 3000;

// Twilio client
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const fromWhatsAppNumber = "whatsapp:" + process.env.TWILIO_WHATSAPP_NUMBER;

// Google Sheets setup
const auth = new google.auth.GoogleAuth({
  keyFile: "credentials.json",
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});

const spreadsheetId = process.env.SPREADSHEET_ID;

const motivationalQuotes = [
  "Keep going, you're doing amazing!",
  "Greatness comes from consistency.",
  "Your goals are valid. Make them happen!",
  "Stay focused. The world needs your light.",
  "One step at a time. You've got this!",
  "Every effort counts. Keep showing up."
];

function suggestTasks(goalText) {
  const goals = goalText.split(",").map(g => g.trim().toLowerCase());
  const taskBank = [];

  goals.forEach(g => {
    if (g.includes("fitness")) taskBank.push("Do 20 push-ups", "Stretch for 10 mins", "Drink 1L of water");
    else if (g.includes("study")) taskBank.push("Revise notes", "Solve practice problems", "Watch a tutorial");
    else if (g.includes("business")) taskBank.push("Check emails", "Schedule social posts", "Contact a lead");
    else taskBank.push("Reflect on progress", "Write goals for tomorrow", "Take a deep breath and smile");
  });

  return [...new Set(taskBank)];
}

async function fetchSheetData() {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });

  const range = "Form Responses 1";

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  const rows = res.data.values;
  if (!rows || rows.length === 0) return [];

  const headers = rows[0];
  return rows.slice(1).map((row) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = row[index];
    });
    return record;
  });
}

function chunkArray(arr, chunks) {
  const perChunk = Math.ceil(arr.length / chunks);
  const result = [];
  for (let i = 0; i < chunks; i++) {
    result.push(arr.slice(i * perChunk, i * perChunk + perChunk));
  }
  return result;
}

function sendReminder(phone, name, tasks) {
  const quote = motivationalQuotes[Math.floor(Math.random() * motivationalQuotes.length)];
  const message = `Hello ${name}, here's your reminder for today:\n` +
    tasks.map((task, i) => `Task ${i + 1}: ${task}`).join("\n") +
    `\n\n💡 ${quote}`;

  client.messages.create({
    body: message,
    from: fromWhatsAppNumber,
    to: "whatsapp:" + phone,
  })
    .then((msg) => console.log(`Reminder sent to ${phone}: ${msg.sid}`))
    .catch((err) => console.error("Twilio error:", err));
}

async function scheduleReminders() {
  const records = await fetchSheetData();

  records.forEach((r) => {
    const name = r["Full Name"];
    const phone = r["Phone Number"];
    const goal = r["Goal"];
    const wantsSuggestions = (r["Do you want suggested tasks?"] || "").toLowerCase() === "yes";
    const customTasks = r["If No, list your tasks"] || "";

    const rawTasks = wantsSuggestions ? suggestTasks(goal) : customTasks.split(",").map(t => t.trim());
    const taskChunks = chunkArray(rawTasks, 3); // distribute across 3 times

    const timeFields = [
      "Preferred Reminder Time 1",
      "Preferred Reminder Time 2",
      "Preferred Reminder Time 3"
    ];

    timeFields.forEach((field, index) => {
      const preferredTime = r[field];
      if (!preferredTime) return;

      const momentTime = moment(preferredTime, ["HH:mm", "h:mm A"]);
      const hour = momentTime.hour();
      const minute = momentTime.minute();

      const cronExpression = `${minute} ${hour} * * *`; // Daily

      const tasksForThisTime = taskChunks[index] || [];

      cron.schedule(cronExpression, () => {
        sendReminder(phone, name, tasksForThisTime);
      }, {
        timezone: "Africa/Lagos"
      });
    });
  });
}

// ✅ Run the scheduler once daily at 12:05 AM to set up that day’s reminder jobs
cron.schedule("5 0 * * *", () => {
  console.log("🗓️ Running daily schedule setup...");
  scheduleReminders();
}, {
  timezone: "Africa/Lagos"
});

// Optional manual trigger for dev/debug
app.get("/trigger", (req, res) => {
  scheduleReminders();
  res.send("Reminders scheduled.");
});

app.get("/", (req, res) => {
  res.send("✅ Reminder bot is live and running!");
});

// Schedule the master trigger once daily at 12:05 AM
// cron.schedule("5 0 * * *", () => {
//   console.log("⏰ Running daily setup of reminders...");
  // scheduleReminders();
// }, {
//   timezone: "Africa/Lagos"
// });


app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
}); 