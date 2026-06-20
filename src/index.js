// Telegram-бот для моніторингу спреду USD і EUR у monobank.
// Спред = rateSell - rateBuy = вартість кругової угоди
// (продав за rateBuy, одразу відкупив за rateSell). Що менший спред,
// то дешевше «продати й одразу купити».
//
// Деплоїться на Cloudflare Workers: webhook (fetch) + Cron Trigger (scheduled).

const MONO_CURRENCY_URL = "https://api.monobank.ua/bank/currency";
const UAH = 980;

// Відстежувані валюти: код ISO 4217 -> ключ
const CURRENCIES = {
  USD: 840,
  EUR: 978,
};
const CUR_KEYS = Object.keys(CURRENCIES);
const CUR_ALIASES = { usd: "USD", eur: "EUR", "840": "USD", "978": "EUR" };

const DEFAULT_THRESHOLD = 0.5; // поріг різниці за замовчуванням, грн

const tg = (token, method) => `https://api.telegram.org/bot${token}/${method}`;
const round = (n) => Math.round(n * 10000) / 10000;

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("mono-rate-bot is running", { status: 200 });
    }
    if (env.WEBHOOK_SECRET) {
      const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (got !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
    }
    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    ctx.waitUntil(handleUpdate(update, env).catch((e) => console.error(e)));
    return new Response("OK", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkRates(env).catch((e) => console.error(e)));
  },
};

// ---------- monobank ----------

// Повертає { USD: {buy, sell, spread, date} | null, EUR: ... }
async function getRates() {
  const resp = await fetch(MONO_CURRENCY_URL, {
    headers: { "User-Agent": "cf-worker-mono-rate-bot" },
  });
  if (!resp.ok) throw new Error(`monobank API: HTTP ${resp.status}`);
  const data = await resp.json();

  const out = {};
  for (const cur of CUR_KEYS) {
    const code = CURRENCIES[cur];
    const row = data.find(
      (c) => c.currencyCodeA === code && c.currencyCodeB === UAH
    );
    if (row && row.rateBuy != null && row.rateSell != null) {
      out[cur] = {
        buy: row.rateBuy,
        sell: row.rateSell,
        spread: round(row.rateSell - row.rateBuy),
        date: row.date,
      };
    } else {
      // Уночі/у вихідні готівкового курсу може не бути (є лише rateCross)
      out[cur] = null;
    }
  }
  return out;
}

// Отримати курси й оновити запам'ятований мінімум спреду (глобально по валюті)
async function fetchAndRecord(env) {
  const rates = await getRates();
  for (const cur of CUR_KEYS) {
    const r = rates[cur];
    if (r) await recordMin(env, cur, r.spread);
  }
  return rates;
}

// ---------- Telegram ----------

async function sendMessage(env, chatId, text) {
  const resp = await fetch(tg(env.BOT_TOKEN, "sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
  if (!resp.ok) {
    console.error("sendMessage failed", resp.status, await resp.text());
  }
}

// ---------- KV ----------

const chatKey = (id) => `chat:${id}`;
const minKey = (cur) => `min:${cur}`;

function normalizeChat(chat) {
  chat = chat || {};
  if (typeof chat.enabled !== "boolean") chat.enabled = true;

  if (!chat.thresholds) {
    // міграція зі старого формату { threshold: number }
    const legacy =
      typeof chat.threshold === "number" ? chat.threshold : DEFAULT_THRESHOLD;
    chat.thresholds = { USD: legacy };
  }
  for (const cur of CUR_KEYS) {
    if (chat.thresholds[cur] == null) chat.thresholds[cur] = DEFAULT_THRESHOLD;
  }

  if (!chat.notified) chat.notified = {};
  for (const cur of CUR_KEYS) {
    if (typeof chat.notified[cur] !== "boolean") chat.notified[cur] = false;
  }
  return chat;
}

async function getChat(env, chatId) {
  const raw = await env.KV.get(chatKey(chatId));
  return normalizeChat(raw ? JSON.parse(raw) : null);
}

async function saveChat(env, chatId, data) {
  await env.KV.put(chatKey(chatId), JSON.stringify(data));
}

async function getMin(env, cur) {
  const raw = await env.KV.get(minKey(cur));
  return raw ? JSON.parse(raw) : null;
}

async function recordMin(env, cur, spread) {
  const cur_min = await getMin(env, cur);
  if (!cur_min || spread < cur_min.spread) {
    await env.KV.put(minKey(cur), JSON.stringify({ spread, at: Date.now() }));
  }
}

// ---------- Команди ----------

async function handleUpdate(update, env) {
  const message = update.message || update.edited_message;
  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const parts = message.text.trim().split(/\s+/);
  const cmd = parts[0].split("@")[0].toLowerCase();

  switch (cmd) {
    case "/start":
      return cmdStart(env, chatId);
    case "/set":
      return cmdSet(env, chatId, parts);
    case "/status":
      return cmdStatus(env, chatId);
    case "/check":
      return cmdCheck(env, chatId);
    case "/reset":
      return cmdReset(env, chatId);
    case "/stop":
      return cmdStop(env, chatId);
    case "/help":
      return sendMessage(env, chatId, helpText());
    default:
      return sendMessage(env, chatId, "Невідома команда.\n\n" + helpText());
  }
}

function helpText() {
  return [
    "<b>Монітор спреду USD/EUR у monobank</b>",
    "Спред = продаж − купівля = у стільки обійдеться «продати й одразу купити».",
    "Пишу, коли спред опускається до вашого порога.",
    "",
    "Команди:",
    "/set usd 0.2 — поріг для долара (грн)",
    "/set eur 0.3 — поріг для євро",
    "/set 0.25 — один поріг одразу для обох",
    "/status — курс, спред, поріг і мінімум по обох валютах",
    "/check — поточний курс просто зараз",
    "/reset — обнулити запам'ятований мінімум спреду",
    "/stop — вимкнути сповіщення",
    "/help — довідка",
  ].join("\n");
}

async function cmdStart(env, chatId) {
  const chat = await getChat(env, chatId);
  chat.enabled = true;
  await saveChat(env, chatId, chat);
  const th = CUR_KEYS.map((c) => `${c}: ${chat.thresholds[c]}`).join(", ");
  await sendMessage(
    env,
    chatId,
    `Сповіщення увімкнено.\nПоточні пороги (грн): <b>${th}</b>\n\n` + helpText()
  );
}

async function cmdSet(env, chatId, parts) {
  const a = (parts[1] || "").toLowerCase();
  let cur = null;
  let valueStr;

  if (Object.prototype.hasOwnProperty.call(CUR_ALIASES, a)) {
    cur = CUR_ALIASES[a];
    valueStr = parts[2];
  } else {
    valueStr = parts[1]; // без валюти -> ставимо обом
  }

  const value = parseFloat((valueStr || "").replace(",", "."));
  if (!isFinite(value) || value < 0) {
    return sendMessage(
      env,
      chatId,
      "Потрібне число. Приклади:\n" +
        "<code>/set usd 0.2</code> — поріг для долара\n" +
        "<code>/set eur 0.3</code> — для євро\n" +
        "<code>/set 0.25</code> — для обох одразу"
    );
  }

  const chat = await getChat(env, chatId);
  const targets = cur ? [cur] : CUR_KEYS;
  for (const c of targets) {
    chat.thresholds[c] = round(value);
    chat.notified[c] = false; // скидаємо, щоб спрацювало знову на новому порозі
  }
  chat.enabled = true;
  await saveChat(env, chatId, chat);

  const th = CUR_KEYS.map((c) => `${c}: ${chat.thresholds[c]}`).join(", ");
  await sendMessage(env, chatId, `Пороги (грн): <b>${th}</b>`);
}

async function cmdStatus(env, chatId) {
  const chat = await getChat(env, chatId);
  let rates = null;
  try {
    rates = await fetchAndRecord(env);
  } catch (e) {
    console.error(e);
  }

  const lines = [];
  for (const cur of CUR_KEYS) {
    const r = rates ? rates[cur] : null;
    const th = chat.thresholds[cur];
    const min = await getMin(env, cur);
    if (r) {
      lines.push(
        `<b>${cur}</b>: купівля ${r.buy} · продаж ${r.sell}`,
        `  спред <b>${r.spread}</b> грн · поріг ${th}`
      );
    } else {
      lines.push(`<b>${cur}</b>: курс недоступний · поріг ${th}`);
    }
    if (min) lines.push(`  мінімум спреду: <b>${min.spread}</b> (${fmtTime(min.at)})`);
  }
  lines.push("", `Сповіщення: <b>${chat.enabled ? "увімкнено" : "вимкнено"}</b>`);
  await sendMessage(env, chatId, lines.join("\n"));
}

async function cmdCheck(env, chatId) {
  let rates;
  try {
    rates = await fetchAndRecord(env);
  } catch (e) {
    return sendMessage(env, chatId, `Не вдалося отримати курс: ${e.message}`);
  }
  const lines = [];
  for (const cur of CUR_KEYS) {
    const r = rates[cur];
    lines.push(
      r
        ? `<b>${cur}</b>: купівля ${r.buy} · продаж ${r.sell} · спред <b>${r.spread}</b> грн`
        : `<b>${cur}</b>: курс недоступний`
    );
  }
  await sendMessage(env, chatId, lines.join("\n"));
}

async function cmdReset(env, chatId) {
  for (const cur of CUR_KEYS) await env.KV.delete(minKey(cur));
  await sendMessage(env, chatId, "Запам'ятований мінімум спреду обнулено.");
}

async function cmdStop(env, chatId) {
  const chat = await getChat(env, chatId);
  chat.enabled = false;
  await saveChat(env, chatId, chat);
  await sendMessage(env, chatId, "Сповіщення вимкнено. /start — увімкнути знову.");
}

function fmtTime(ts) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString("uk-UA", {
      timeZone: "Europe/Kyiv",
      hour12: false,
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return new Date(ts).toISOString();
  }
}

// ---------- Cron: періодична перевірка ----------

async function checkRates(env) {
  let rates;
  try {
    rates = await fetchAndRecord(env);
  } catch (e) {
    console.error("checkRates: курс недоступний:", e.message);
    return;
  }

  let cursor;
  do {
    const list = await env.KV.list({ prefix: "chat:", cursor });
    for (const key of list.keys) {
      const raw = await env.KV.get(key.name);
      if (!raw) continue;
      const chat = normalizeChat(JSON.parse(raw));
      if (!chat.enabled) continue;

      const chatId = key.name.slice("chat:".length);
      let changed = false;

      for (const cur of CUR_KEYS) {
        const r = rates[cur];
        if (!r) continue;
        const th = chat.thresholds[cur] ?? DEFAULT_THRESHOLD;

        if (r.spread <= th) {
          if (!chat.notified[cur]) {
            await sendMessage(
              env,
              chatId,
              `🔔 <b>${cur}</b>: спред <b>${r.spread}</b> грн (поріг ${th}).\n` +
                `Купівля ${r.buy} · продаж ${r.sell}`
            );
            chat.notified[cur] = true;
            changed = true;
          }
        } else if (chat.notified[cur]) {
          chat.notified[cur] = false; // спред виріс — дозволяємо спрацювати знову
          changed = true;
        }
      }

      if (changed) await env.KV.put(key.name, JSON.stringify(chat));
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
}
