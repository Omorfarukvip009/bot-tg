import { Telegraf } from "telegraf";
import { exec } from "child_process";
import fs from "fs";
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import crypto from "crypto";
import { MongoClient } from "mongodb";
import session from "express-session";
import JSZip from "jszip";

dotenv.config();

// ========= ENV =========
const {
  BOT_TOKEN,
  API_ID,
  API_HASH,
  ADMIN_CHAT_ID,
  MONGO_URI,
  DB_NAME = "telegramBot",
  PORT = 3000,
  SESSION_SECRET = "supersecret",
  RENDER_EXTERNAL_URL
} = process.env;

const ADMIN_USER = "FrkBzy001";
const ADMIN_PASS = "Omorfaruk00";

// ========= MONGO =========
const client = new MongoClient(MONGO_URI);
let db;
async function connectDB() {
  if (!db) {
    await client.connect();
    db = client.db(DB_NAME);
    console.log("✅ MongoDB connected!");
  }
  return db;
}

// ========= UTIL =========
const uid = () => crypto.randomBytes(8).toString("hex");

async function loadCountries() {
  const d = await connectDB();
  const docs = await d.collection("countries").find({}).toArray();
  const obj = {};
  docs.forEach((c) => (obj[c.prefix] = c));
  return obj;
}
async function saveCountry(prefix, data) {
  const d = await connectDB();
  await d.collection("countries").updateOne({ prefix }, { $set: { ...data, prefix } }, { upsert: true });
}
async function getBalance(userId) {
  const d = await connectDB();
  return (await d.collection("balances").findOne({ user_id: userId })) || { balance: 0 };
}
async function addBalance(userId, name, amount) {
  const d = await connectDB();
  const res = await d.collection("balances").findOneAndUpdate(
    { user_id: userId },
    { $set: { name }, $inc: { balance: Number(amount) } },
    { upsert: true, returnDocument: "after" }
  );
  return res.value.balance;
}
async function deductBalance(userId, amt) {
  const d = await connectDB();
  await d.collection("balances").updateOne({ user_id: userId }, { $inc: { balance: -amt } });
}
async function addWithdrawRequest(data) {
  const d = await connectDB();
  await d.collection("withdraws").insertOne(data);
}
async function getWithdraws() {
  const d = await connectDB();
  return await d.collection("withdraws").find({}).toArray();
}
async function getWithdrawById(id) {
  const d = await connectDB();
  return await d.collection("withdraws").findOne({ id });
}
async function updateWithdrawStatus(id, status, txid) {
  const d = await connectDB();
  await d.collection("withdraws").updateOne({ id }, { $set: { status, txid } });
}

// ========= SESSION DB =========
async function saveSessionToDB(phone, fileBuffer) {
  const d = await connectDB();
  await d.collection("sessions").insertOne({
    phone,
    file: fileBuffer.toString("base64"),
    date: new Date().toISOString()
  });
}
async function getSessions() {
  const d = await connectDB();
  return await d.collection("sessions").find({}).toArray();
}
async function clearSessions() {
  const d = await connectDB();
  await d.collection("sessions").deleteMany({});
}

function detectCountryByPrefix(phone, countries) {
  const keys = Object.keys(countries).sort((a, b) => b.length - a.length);
  const match = keys.find((k) => phone.startsWith(k));
  return match ? countries[match] : null;
}
function userLabel(ctx) {
  const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ");
  return `${name || "Unknown"} ${ctx.from.username ? `@${ctx.from.username}` : ""} (ID:${ctx.from.id})`;
}

// ========= BOT =========
const bot = new Telegraf(BOT_TOKEN);
const userState = {};

const mainKeyboard = {
  reply_markup: {
    keyboard: [["💲 আমার আয়", "💸 টাকা তুলুন", "📜 বিক্রির ইতিহাস"]],
    resize_keyboard: true,
  },
};

bot.start((ctx) => {
  if (ctx.chat.type !== "private") return;
  userState[ctx.chat.id] = {};
  ctx.reply(
    "👋 স্বাগতম!\nআমাদের সাথে আপনার টেলিগ্রাম সেশন বিক্রি করতে ফোন নাম্বার পাঠান অথবা নিচের অপশন ব্যবহার করুন।",
    mainKeyboard
  );
});

bot.hears("💲 আমার আয়", async (ctx) => {
  const b = await getBalance(ctx.chat.id);
  ctx.reply(`💰 আপনার মোট আয়: $${(b.balance || 0).toFixed(2)}`, mainKeyboard);
});

bot.hears("💸 টাকা তুলুন", (ctx) => {
  userState[ctx.chat.id] = { step: "withdraw_card" };
  ctx.reply("💳 টাকা তোলার জন্য আপনার লিডার কার্ড লিখুন:", mainKeyboard);
});

bot.hears("📜 বিক্রির ইতিহাস", async (ctx) => {
  const all = await getWithdraws();
  const mine = all.filter((x) => x.user_id === ctx.chat.id);
  if (!mine.length) return ctx.reply("📭 কোনো ইতিহাস নেই।", mainKeyboard);
  ctx.reply(mine.map((r) => `#${r.id} • $${r.amount} • ${r.status}`).join("\n"), mainKeyboard);
});

bot.on("text", async (ctx) => {
  const userId = ctx.chat.id;
  const msg = ctx.message.text.trim();

  if (userState[userId]?.step === "withdraw_card") {
    userState[userId].card = msg;
    userState[userId].step = "withdraw_amt";
    return ctx.reply("💸 কত টাকা তুলতে চান (USD):", mainKeyboard);
  }
  if (userState[userId]?.step === "withdraw_amt") {
    const amt = Number(msg);
    if (!amt) return ctx.reply("❌ পরিমাণ সঠিক নয়।");
    const id = uid();
    await addWithdrawRequest({
      id,
      user_id: userId,
      username: ctx.from.username || "",
      card: userState[userId].card,
      amount: amt,
      status: "pending",
      date: new Date().toISOString(),
    });
    userState[userId] = {};
    ctx.reply(`✅ আপনার টাকা তোলার অনুরোধ (#${id}) গৃহীত হয়েছে।`, mainKeyboard);
    return;
  }

  if (msg.startsWith("+")) {
    const countries = await loadCountries();
    const country = detectCountryByPrefix(msg, countries);
    if (!country?.allowed) {
      return ctx.reply(`🚫 বর্তমানে ${country?.country || "আপনার দেশ"} থেকে সেশন বিক্রি বন্ধ আছে।`, mainKeyboard);
    }
    ctx.reply("📲 আপনার নম্বরে OTP পাঠানো হচ্ছে...");
    exec(`python3 session.py ${API_ID} ${API_HASH} ${msg} request`, (err, stdout) => {
      if (err || !String(stdout).includes("CODE_REQUESTED")) {
        return ctx.reply("❌ OTP পাঠানো ব্যর্থ।", mainKeyboard);
      }
      userState[userId] = { phone: msg, waitingForOtp: true, rate: country.rate };
      ctx.reply("✅ OTP পাঠানো হয়েছে। দয়া করে লিখুন:", mainKeyboard);
    });
    return;
  }

  if (userState[userId]?.waitingForOtp) {
    ctx.reply("⏳ আপনার সেশন যাচাই হচ্ছে...");
    const { phone, rate } = userState[userId];
    exec(`python3 session.py ${API_ID} ${API_HASH} ${phone} otp=${msg}`, async (err, stdout) => {
      if (err) return ctx.reply("❌ OTP যাচাই ব্যর্থ।");
      if (!String(stdout).includes("SESSION_FILE")) return ctx.reply("❌ সেশন তৈরি ব্যর্থ।");
      const filePath = `${phone}.session`;
      if (fs.existsSync(filePath)) {
        const buffer = fs.readFileSync(filePath);
        await saveSessionToDB(phone, buffer); // ✅ save in DB
      }
      const newBal = await addBalance(userId, ctx.from.first_name, rate);
      ctx.reply(`✅ আপনার সেশন গৃহীত হয়েছে!\n💵 নতুন ব্যালেন্স: $${newBal.toFixed(2)}`, mainKeyboard);
      await bot.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `🆕 নতুন সেশন বিক্রি!\n👤 ${userLabel(ctx)}\n📞 ${phone}\n💲 রেট: $${rate}`
      );
    });
    userState[userId] = {};
    return;
  }

  ctx.reply("❌ ইনপুট সঠিক নয়।", mainKeyboard);
});

// ========= ADMIN PANEL =========
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: true }));

app.get("/", (req, res) => {
  if (!req.session.loggedIn) {
    return res.send(`
      <html><head><title>Login</title><script src="https://cdn.tailwindcss.com"></script></head>
      <body class="bg-gray-100 flex items-center justify-center h-screen">
        <form method="POST" action="/login" class="bg-white p-6 rounded shadow-md space-y-4 w-80">
          <h1 class="text-2xl font-bold text-center">🔑 Admin Login</h1>
          <input type="text" name="username" placeholder="Username" class="border p-2 w-full rounded" required/>
          <input type="password" name="password" placeholder="Password" class="border p-2 w-full rounded" required/>
          <button class="bg-blue-600 hover:bg-blue-700 text-white w-full py-2 rounded">Login</button>
        </form>
      </body></html>
    `);
  }
  res.redirect("/panel");
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.loggedIn = true;
    return res.redirect("/panel");
  }
  res.send("❌ Wrong username or password.");
});

app.get("/panel", async (req, res) => {
  if (!req.session.loggedIn) return res.redirect("/");
  const countries = await loadCountries();
  const balances = await connectDB().then((d) => d.collection("balances").find({}).toArray());
  const withdraws = await getWithdraws();
  const sessions = await getSessions();

  res.send(`
  <html><head><title>Admin Panel</title><script src="https://cdn.tailwindcss.com"></script></head>
  <body class="bg-gray-50 p-6">
    <h1 class="text-3xl font-bold mb-6">🤖 সেশন বিক্রির Admin Panel</h1>
    <div class="bg-white p-4 rounded-xl shadow mb-6">
      <h2 class="text-xl font-semibold mb-2">📦 Saved Sessions (${sessions.length})</h2>
      <ul class="list-disc pl-5">${sessions.map(s => `<li>${s.phone}</li>`).join("")}</ul>
      <form method="GET" action="/download-sessions">
        <button class="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded mt-2">⬇ Download All</button>
      </form>
      <form method="POST" action="/clear-sessions">
        <button class="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded mt-2">🗑 Clear Old Sessions</button>
      </form>
    </div>
    <div class="bg-white p-4 rounded-xl shadow mb-6">
      <h2 class="text-xl font-semibold mb-2">🌍 দেশ সেটিংস</h2>
      <form method="POST" action="/set-country" class="flex flex-wrap gap-2">
        <input name="prefix" placeholder="+1" required class="border p-2 rounded"/>
        <input name="country" placeholder="Country" required class="border p-2 rounded"/>
        <select name="allowed" class="border p-2 rounded"><option value="true">Allowed</option><option value="false">Blocked</option></select>
        <input name="rate" type="number" step="0.01" placeholder="Rate" required class="border p-2 rounded w-24"/>
        <input name="confirmation_time" type="number" placeholder="Confirm(min)" required class="border p-2 rounded w-32"/>
        <button class="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded">Save</button>
      </form>
      <pre class="bg-gray-100 p-3 mt-3 rounded">${JSON.stringify(countries, null, 2)}</pre>
    </div>
    <div class="bg-white p-4 rounded-xl shadow mb-6">
      <h2 class="text-xl font-semibold mb-2">💰 Seller Earnings</h2>
      <pre class="bg-gray-100 p-3 rounded">${JSON.stringify(balances, null, 2)}</pre>
    </div>
    <div class="bg-white p-4 rounded-xl shadow">
      <h2 class="text-xl font-semibold mb-2">💸 Withdraw Requests</h2>
      <table class="w-full border">
        ${withdraws.map(w => `
        <tr>
          <td>${w.id}</td><td>${w.user_id}</td><td>${w.card}</td><td>$${w.amount}</td><td>${w.status}</td>
          <td>${w.status === "pending" ? `
            <form method="POST" action="/withdraw/${w.id}/approve">
              <input name="txid" placeholder="Txn ID" required class="border p-1 rounded"/>
              <button class="bg-green-500 hover:bg-green-600 text-white px-2 py-1 rounded">Approve</button>
            </form>
            <form method="POST" action="/withdraw/${w.id}/reject">
              <button class="bg-red-500 hover:bg-red-600 text-white px-2 py-1 rounded">Reject</button>
            </form>` : ""}
          </td>
        </tr>`).join("")}
      </table>
    </div>
  </body></html>
  `);
});

app.get("/download-sessions", async (req, res) => {
  if (!req.session.loggedIn) return res.redirect("/");
  const sessions = await getSessions();
  const zip = new JSZip();
  sessions.forEach((s) => {
    zip.file(`${s.phone}.session`, Buffer.from(s.file, "base64"));
  });
  const content = await zip.generateAsync({ type: "nodebuffer" });
  res.setHeader("Content-Disposition", "attachment; filename=allsessions.zip");
  res.setHeader("Content-Type", "application/zip");
  res.send(content);
});

app.post("/clear-sessions", async (req, res) => {
  if (!req.session.loggedIn) return res.redirect("/");
  await clearSessions();
  res.redirect("/panel");
});

app.post("/set-country", async (req, res) => {
  await saveCountry(req.body.prefix, {
    country: req.body.country,
    allowed: req.body.allowed === "true",
    rate: Number(req.body.rate),
    confirmation_time: Number(req.body.confirmation_time),
  });
  res.redirect("/panel");
});

app.post("/withdraw/:id/approve", async (req, res) => {
  const w = await getWithdrawById(req.params.id);
  if (!w) return res.redirect("/panel");

  await deductBalance(w.user_id, w.amount);
  await updateWithdrawStatus(req.params.id, "approved", req.body.txid);

  try {
    await bot.telegram.sendMessage(
      w.user_id,
      `✅ আপনার টাকা তোলার অনুরোধ অনুমোদিত!\n💸 পরিমাণ: $${w.amount}\n🔑 TXID: ${req.body.txid}`
    );
  } catch (e) {
    console.log("⚠️ Could not notify user:", e.message);
  }

  res.redirect("/panel");
});

app.post("/withdraw/:id/reject", async (req, res) => {
  await updateWithdrawStatus(req.params.id, "rejected");
  res.redirect("/panel");
});

// ========= WEBHOOK START =========
connectDB().then(async () => {
  app.use(await bot.createWebhook({ domain: RENDER_EXTERNAL_URL, path: "/webhook" }));
  app.listen(PORT, () => console.log(`🌐 Admin Panel running on ${PORT}`));
  console.log(`🚀 Bot running in Webhook mode at ${RENDER_EXTERNAL_URL}/webhook`);
});
