const fs = require('fs');
const dotenv = require('dotenv');
dotenv.config();

// Initialize credentials from base64
const base64Creds = process.env.GOOGLE_CREDENTIALS_BASE64;
if (base64Creds) {
  const buff = Buffer.from(base64Creds, 'base64');
  fs.writeFileSync('./credentials.json', buff);
  console.log('✅ credentials.json file created from base64 env var.');
} else {
  console.error('❌ Error: GOOGLE_CREDENTIALS_BASE64 env var is not set');
  process.exit(1);
}

const express = require("express");
const { google } = require("googleapis");
const cron = require("node-cron");
const twilio = require("twilio");
const moment = require("moment-timezone");
const { v4: uuidv4 } = require('uuid');

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

// Enhanced motivational quotes database
const motivationalQuotes = [
  "Keep going, you're doing amazing!",
  "Greatness comes from consistency.",
  "Your goals are valid. Make them happen!",
  "Stay focused. The world needs your light.",
  "One step at a time. You've got this!",
  "Every effort counts. Keep showing up.",
  "Small steps every day lead to big results.",
  "Believe you can and you're halfway there.",
  "Your future is created by what you do today.",
  "Progress is progress, no matter how small."
];

// Task database for suggestions
const taskDatabase = {
  fitness: [
    "Do 20 push-ups", 
    "Stretch for 10 mins", 
    "Drink 1L of water",
    "Take a 15-minute walk",
    "Do 3 sets of squats"
  ],
  study: [
    "Revise notes for 30 mins", 
    "Solve practice problems", 
    "Watch a tutorial video",
    "Read a chapter",
    "Create flashcards"
  ],
  business: [
    "Check and respond to emails", 
    "Schedule social media posts", 
    "Contact a potential client",
    "Review business metrics",
    "Brainstorm new ideas"
  ],
  health: [
    "Eat a healthy meal",
    "Meditate for 5 minutes",
    "Get 7-8 hours of sleep",
    "Take your vitamins",
    "Drink herbal tea"
  ],
  general: [
    "Reflect on your progress",
    "Write goals for tomorrow",
    "Practice gratitude",
    "Help someone today",
    "Learn something new"
  ]
};

// Track scheduled jobs to prevent duplicates
const scheduledJobs = new Map();

function suggestTasks(goalText) {
  const goals = goalText.split(",").map(g => g.trim().toLowerCase());
  const taskBank = new Set();

  goals.forEach(g => {
    // Match goals to our task categories
    if (g.includes("fit") || g.includes("exercise")) {
      taskDatabase.fitness.forEach(task => taskBank.add(task));
    }
    if (g.includes("study") || g.includes("learn")) {
      taskDatabase.study.forEach(task => taskBank.add(task));
    }
    if (g.includes("business") || g.includes("work")) {
      taskDatabase.business.forEach(task => taskBank.add(task));
    }
    if (g.includes("health") || g.includes("wellness")) {
      taskDatabase.health.forEach(task => taskBank.add(task));
    }
    
    // Always add some general tasks
    taskDatabase.general.forEach(task => taskBank.add(task));
  });

  return Array.from(taskBank);
}

async function fetchSheetData() {
  try {
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
        record[header] = row[index] || '';
      });
      return record;
    });
  } catch (error) {
    console.error("Error fetching sheet data:", error);
    return [];
  }
}

function distributeTasks(tasks, chunks) {
  if (!tasks || tasks.length === 0) return Array(chunks).fill([]);
  
  const perChunk = Math.ceil(tasks.length / chunks);
  const result = [];
  for (let i = 0; i < chunks; i++) {
    result.push(tasks.slice(i * perChunk, i * perChunk + perChunk));
  }
  return result;
}

async function sendReminder(phone, name, tasks, attempt = 1) {
  if (!phone || !name) {
    console.error("Missing phone or name for reminder");
    return;
  }

  const whatsappNumber = phone.startsWith("whatsapp:+") ? phone : `whatsapp:+${phone.replace(/\D/g, '')}`;
  const quote = motivationalQuotes[Math.floor(Math.random() * motivationalQuotes.length)];
  
  let messageBody;
  if (tasks.length === 0) {
    messageBody = `Hello ${name}, just checking in! Remember to work towards your goals today!\n\n💡 ${quote}`;
  } else {
    messageBody = `Hello ${name}, here's your reminder for today:\n` +
      tasks.map((task, i) => `${i + 1}. ${task}`).join("\n") +
      `\n\n💡 ${quote}`;
  }

  try {
    const msg = await client.messages.create({
      body: messageBody,
      from: fromWhatsAppNumber,
      to: whatsappNumber,
    });
    console.log(`Reminder sent to ${name} (${phone}): ${msg.sid}`);
  } catch (err) {
    console.error(`Twilio error for ${phone}:`, err.message);
    
    // Retry logic (max 3 attempts)
    if (attempt <= 3) {
      console.log(`Retrying (attempt ${attempt})...`);
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
      return sendReminder(phone, name, tasks, attempt + 1);
    }
  }
}

function clearExistingJobs(userId) {
  if (scheduledJobs.has(userId)) {
    const jobs = scheduledJobs.get(userId);
    jobs.forEach(job => job.stop());
    scheduledJobs.delete(userId);
    console.log(`Cleared existing jobs for user ${userId}`);
  }
}

async function scheduleReminders() {
  try {
    console.log("⏰ Fetching user data and scheduling reminders...");
    const records = await fetchSheetData();

    records.forEach((record) => {
      const userId = record["Phone Number"] || uuidv4();
      const name = record["Full Name"] || "User";
      const phone = record["Phone Number"];
      const goal = record["Goal"] || "";
      const wantsSuggestions = (record["Do you want suggested tasks?"] || "").toLowerCase() === "yes";
      const customTasks = record["If No, list your tasks"] || "";
      const timezone = record["Timezone"] || "Africa/Lagos";

      // Clear any existing jobs for this user
      clearExistingJobs(userId);

      // Process tasks
      const rawTasks = wantsSuggestions ? suggestTasks(goal) : 
                      customTasks.split(",").map(t => t.trim()).filter(t => t);
      
      // Get reminder times (assuming 3 time fields)
      const timeFields = [
        "Preferred Reminder Time 1",
        "Preferred Reminder Time 2",
        "Preferred Reminder Time 3"
      ];

      const validTimes = timeFields
        .map(field => record[field])
        .filter(time => time && time.trim() !== '');

      if (validTimes.length === 0) {
        console.log(`No valid reminder times for ${name} (${phone})`);
        return;
      }

      // Distribute tasks across available times
      const taskChunks = distributeTasks(rawTasks, validTimes.length);
      const userJobs = [];

      validTimes.forEach((time, index) => {
        try {
          const momentTime = moment.tz(time, ["HH:mm", "h:mm A"], timezone);
          if (!momentTime.isValid()) {
            console.error(`Invalid time format for ${name}: ${time}`);
            return;
          }

          const hour = momentTime.hour();
          const minute = momentTime.minute();
          const cronExpression = `${minute} ${hour} * * *`;

          const tasksForThisTime = taskChunks[index] || [];
          const job = cron.schedule(cronExpression, () => {
            console.log(`Executing reminder for ${name} at ${time} (${timezone})`);
            sendReminder(phone, name, tasksForThisTime);
          }, {
            timezone: timezone,
            scheduled: true
          });

          userJobs.push(job);
          console.log(`Scheduled reminder for ${name} at ${time} (${timezone}) with ${tasksForThisTime.length} tasks`);
        } catch (error) {
          console.error(`Error scheduling for ${name} at ${time}:`, error);
        }
      });

      // Store jobs for cleanup later
      if (userJobs.length > 0) {
        scheduledJobs.set(userId, userJobs);
      }
    });
  } catch (error) {
    console.error("Error in scheduleReminders:", error);
  }
}

// Daily job to refresh all reminders
cron.schedule("5 0 * * *", () => {
  console.log("🔄 Running daily schedule refresh...");
  scheduleReminders();
}, {
  timezone: "Africa/Lagos"
});

// Manual trigger endpoint
app.get("/trigger", async (req, res) => {
  await scheduleReminders();
  res.send("Reminders scheduled manually.");
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    scheduledJobs: scheduledJobs.size,
    lastUpdated: new Date().toISOString()
  });
});

app.get("/", (req, res) => {
  res.send("✅ WhatsApp Reminder Bot is live and running!");
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  // Initial schedule run
  scheduleReminders().catch(err => console.error("Initial scheduling error:", err));
});