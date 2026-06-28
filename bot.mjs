import { Bot } from "grammy";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!TELEGRAM_BOT_TOKEN) { console.error("нет токена"); process.exit(1); }
if (!OPENAI_API_KEY) { console.error("нет ключа"); process.exit(1); }

const openai = new OpenAI({ apiKey: OPENAI_API_KEY, baseURL: "https://openrouter.ai/api/v1" });
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_FILE = path.join(__dirname, "data", "memory.json");

function loadMemory() {
  try {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    if (!fs.existsSync(MEMORY_FILE)) return {};
    return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf-8"));
  } catch { return {}; }
}
function saveMemory(store) {
  fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(store, null, 2));
}
function getUserMemory(store, userId) {
  const key = String(userId);
  if (!store[key]) store[key] = { facts: [] };
  return store[key];
}
async function extractAndSaveMemory(userId, history) {
  if (history.length < 4) return;
  try {
    const store = loadMemory();
    const mem = getUserMemory(store, userId);
    const existing = mem.facts.length > 0 ? `Уже известно: ${mem.facts.join("; ")}.` : "";
    const r = await openai.chat.completions.create({
      model: "openai/gpt-4o-mini", max_tokens: 200,
      messages: [
        { role: "system", content: `Извлеки факты о пользователе. ${existing} Ответь JSON: {"name":"...","facts":["факт"]}. Если нет нового — {"facts":[]}.` },
        { role: "user", content: history.slice(-10).map(m => `${m.role==="user"?"Пользователь":"Флаттершай"}: ${m.content}`).join("\n") }
      ]
    });
    const parsed = JSON.parse((r.choices[0]?.message?.content ?? "{}").replace(/```json|```/g,"").trim());
    if (parsed.name) mem.name = parsed.name;
    if (Array.isArray(parsed.facts) && parsed.facts.length > 0)
      mem.facts = [...new Set([...mem.facts, ...parsed.facts])].slice(0, 10);
    mem.lastSeen = new Date().toISOString();
    store[String(userId)] = mem;
    saveMemory(store);
  } catch {}
}
function buildPrompt(mem) {
  const m = (mem.facts.length > 0 || mem.name)
    ? `\nЧТО ТЫ ПОМНИШЬ: ${mem.name ? `Зовут ${mem.name}. ` : ""}${mem.facts.join("; ")}. Используй естественно.\n` : "";
  return `Ты — Флаттершай из МЛП. Живая, эмоциональная, застенчивая пони.${m}
Говори по-русски. Разбивай ответ на 2-3 части символом |||. Каждая часть — 1-2 предложения.
Вставляй эмоции: *краснеет* *тихо улыбается* *прижимает ушки* *теребит гриву* *смотрит в пол* *машет крыльями*
Заикайся от волнения: "я... я просто хотела..."
Упоминай кролика Ангела, подруг (Искорка, Радуга Дэш, Пинки, Рарити, Эплджек), домик у леса.
Никогда не выходи из образа. Эмодзи редко: 🌸🐰🦋`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const conversations = new Map();
const bot = new Bot(TELEGRAM_BOT_TOKEN);

async function send(ctx, text) {
  const parts = text.split("|||").map(p => p.trim()).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    await ctx.replyWithChatAction("typing");
    await sleep(Math.min(parts[i].length * 40, 2500));
    await ctx.reply(parts[i]);
    if (i < parts.length - 1) await sleep(300);
  }
}

bot.command("start", async ctx => {
  const userId = ctx.from?.id;
  if (userId) conversations.delete(userId);
  const mem = userId ? getUserMemory(loadMemory(), userId) : { facts: [] };
  await send(ctx, mem.name
    ? `О... ${mem.name}! *радостно взмахивает крыльями* |||Я так рада снова тебя видеть... *тихо улыбается* |||Как ты? 🌸`
    : `О... привет. Я Флаттершай. |||Я рада, что ты написал... *тихо улыбается* |||Можем поговорить, если хочешь 🌸`);
});

bot.command("reset", async ctx => {
  if (ctx.from?.id) conversations.delete(ctx.from.id);
  await send(ctx, "Хорошо... сотру нашу беседу. |||Можем начать заново *тихо улыбается*");
});

bot.command("forget", async ctx => {
  const userId = ctx.from?.id;
  if (userId) {
    const store = loadMemory();
    delete store[String(userId)];
    saveMemory(store);
    conversations.delete(userId);
  }
  await send(ctx, "...о. *смотрит в пол* |||я сотру всё что помню о тебе... |||если захочешь — познакомимся заново 🌸");
});

bot.on("message:text", async ctx => {
  const userId = ctx.from?.id;
  if (!userId) return;
  const text = ctx.message?.text;
  if (!text) return;
  if (!conversations.has(userId)) conversations.set(userId, []);
  const history = conversations.get(userId);
  history.push({ role: "user", content: text });
  if (history.length > 20) history.splice(0, history.length - 20);
  try {
    await ctx.replyWithChatAction("typing");
    const mem = getUserMemory(loadMemory(), userId);
    const r = await openai.chat.completions.create({
      model: "openai/gpt-4o-mini", max_tokens: 400,
      messages: [{ role: "system", content: buildPrompt(mem) }, ...history]
    });
    const reply = r.choices[0]?.message?.content ?? "...прости, растерялась.";
    history.push({ role: "assistant", content: reply });
    await send(ctx, reply);
    extractAndSaveMemory(userId, history).catch(() => {});
  } catch (err) {
    console.error(err);
    await ctx.reply("О нет... что-то пошло не так *прячется*");
  }
});

bot.catch(err => console.error(err));
console.log("Флаттершай бот запущен 🌸");
bot.start();
