// Telegram-бот для мониторинга спреда USD и EUR в monobank.
// Спред = rateSell - rateBuy = стоимость круговой сделки
// (продал по rateBuy, сразу откупил по rateSell). Чем меньше спред,
// тем дешевле "продать и сразу купить".
//
// Деплоится на Cloudflare Workers: webhook (fetch) + Cron Trigger (scheduled).

const MONO_CURRENCY_URL = "https://api.monobank.ua/bank/currency";
const UAH = 980;

// Отслеживаемые валюты: код ISO 4217 -> ключ
const CURRENCIES = {
  USD: 840,
  EUR: 978,
};
const CUR_KEYS = Object.keys(CURRENCIES);
const CUR_ALIASES = { usd: "USD", eur: "EUR", "840": "USD", "978": "EUR" };

const DEFAULT_THRESHOLD = 0.5; // порог разницы по умолчанию, грн

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

// Возвращает { USD: {buy, sell, spread, date} | null, EUR: ... }
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
      // По ночам/выходным наличного курса может не быть (есть только rateCross)
      out[cur] = null;
    }
  }
  return out;
}

// Получить курсы и обновить запомненный минимум спреда (глобально по валюте)
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
    // миграция со старого формата { threshold: number }
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

// ---------- Команды ----------

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
      return sendMessage(env, chatId, "Неизвестная команда.\n\n" + helpText());
  }
}

function helpText() {
  return [
    "<b>Монитор спреда USD/EUR в monobank</b>",
    "Спред = продажа − покупка = во столько обойдётся «продать и сразу купить».",
    "Пишу, когда спред опускается до вашего порога.",
    "",
    "Команды:",
    "/set usd 0.2 — порог для доллара (грн)",
    "/set eur 0.3 — порог для евро",
    "/set 0.25 — один порог сразу для обеих",
    "/status — курс, спред, порог и минимум по обеим валютам",
    "/check — текущий курс прямо сейчас",
    "/reset — обнулить запомненный минимум спреда",
    "/stop — выключить уведомления",
    "/help — справка",
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
    `Уведомления включены.\nТекущие пороги (грн): <b>${th}</b>\n\n` + helpText()
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
    valueStr = parts[1]; // без валюты -> ставим обеим
  }

  const value = parseFloat((valueStr || "").replace(",", "."));
  if (!isFinite(value) || value < 0) {
    return sendMessage(
      env,
      chatId,
      "Нужно число. Примеры:\n" +
        "<code>/set usd 0.2</code> — порог для доллара\n" +
        "<code>/set eur 0.3</code> — для евро\n" +
        "<code>/set 0.25</code> — для обеих сразу"
    );
  }

  const chat = await getChat(env, chatId);
  const targets = cur ? [cur] : CUR_KEYS;
  for (const c of targets) {
    chat.thresholds[c] = round(value);
    chat.notified[c] = false; // сбрасываем, чтобы сработало заново на новом пороге
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
        `<b>${cur}</b>: покупка ${r.buy} · продажа ${r.sell}`,
        `  спред <b>${r.spread}</b> грн · порог ${th}`
      );
    } else {
      lines.push(`<b>${cur}</b>: курс недоступен · порог ${th}`);
    }
    if (min) lines.push(`  минимум спреда: <b>${min.spread}</b> (${fmtTime(min.at)})`);
  }
  lines.push("", `Уведомления: <b>${chat.enabled ? "включены" : "выключены"}</b>`);
  await sendMessage(env, chatId, lines.join("\n"));
}

async function cmdCheck(env, chatId) {
  let rates;
  try {
    rates = await fetchAndRecord(env);
  } catch (e) {
    return sendMessage(env, chatId, `Не удалось получить курс: ${e.message}`);
  }
  const lines = [];
  for (const cur of CUR_KEYS) {
    const r = rates[cur];
    lines.push(
      r
        ? `<b>${cur}</b>: покупка ${r.buy} · продажа ${r.sell} · спред <b>${r.spread}</b> грн`
        : `<b>${cur}</b>: курс недоступен`
    );
  }
  await sendMessage(env, chatId, lines.join("\n"));
}

async function cmdReset(env, chatId) {
  for (const cur of CUR_KEYS) await env.KV.delete(minKey(cur));
  await sendMessage(env, chatId, "Запомненный минимум спреда обнулён.");
}

async function cmdStop(env, chatId) {
  const chat = await getChat(env, chatId);
  chat.enabled = false;
  await saveChat(env, chatId, chat);
  await sendMessage(env, chatId, "Уведомления выключены. /start — включить снова.");
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

// ---------- Cron: периодическая проверка ----------

async function checkRates(env) {
  let rates;
  try {
    rates = await fetchAndRecord(env);
  } catch (e) {
    console.error("checkRates: курс недоступен:", e.message);
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
              `🔔 <b>${cur}</b>: спред <b>${r.spread}</b> грн (порог ${th}).\n` +
                `Покупка ${r.buy} · продажа ${r.sell}`
            );
            chat.notified[cur] = true;
            changed = true;
          }
        } else if (chat.notified[cur]) {
          chat.notified[cur] = false; // спред вырос — разрешаем сработать снова
          changed = true;
        }
      }

      if (changed) await env.KV.put(key.name, JSON.stringify(chat));
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
}
