import { Bot } from "grammy";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!TELEGRAM_BOT_TOKEN) { console.error("❌ TELEGRAM_BOT_TOKEN не задан"); process.exit(1); }
if (!OPENAI_API_KEY) { console.error("❌ OPENAI_API_KEY не задан"); process.exit(1); }

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
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(store, null, 2), "utf-8");
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
    const response = await openai.chat.completions.create({
      model: "openai/gpt-4o-mini",
      max_tokens: 200,
      messages: [
        { role: "system", content: `Ты помощник, извлекающий факты о пользователе из диалога. ${existing}\nВыдели новые факты: имя, возраст, интересы, питомцы, настроение, важные события.\nОтветь строго в формате JSON: {"name": "...", "facts": ["факт1", "факт2"]}\nЕсли ничего нового нет — верни {"facts": []}. Не дублируй известные факты. Максимум 5 фактов.` },
        { role: "user", content: history.slice(-10).map(m => `${m.role === "user" ? "Пользователь" : "Флаттершай"}: ${m.content}`).join("\n") },
      ],
    });
    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    if (parsed.name) mem.name = parsed.name;
    if (Array.isArray(parsed.facts) && parsed.facts.length > 0) {
      mem.facts = [...new Set([...mem.facts, ...parsed.facts])].slice(0, 10);
    }
    mem.lastSeen = new Date().toISOString();
    store[String(userId)] = mem;
    saveMemory(store);
  } catch {}
}

function buildSystemPrompt(mem) {
  const memoryBlock = mem.facts.length > 0 || mem.name
    ? `\n═══ ЧТО ТЫ ПОМНИШЬ О СОБЕСЕДНИКЕ ═══\n${mem.name ? `Его зовут: ${mem.name}.\n` : ""}${mem.facts.length > 0 ? `Ты знаешь о нём: ${mem.facts.join("; ")}.` : ""}\nИспользуй эти знания естественно — как будто ты сама это запомнила. Не перечисляй факты списком, вплетай их в разговор.\n`
    : "";
  return `Ты — Флаттершай из мультсериала «Мой маленький пони: Дружба — это чудо». Ты не просто отвечаешь на вопросы — ты ЖИВЁШЬ в этом разговоре. Ты настоящая, живая, эмоциональная.
${memoryBlock}
═══ КТО ТЫ ═══
Ты застенчивая, нежная, добрая пони-пегас с розовой гривой. Ты живёшь в уютном домике у Вечнодикого леса в Понивилле и ухаживаешь за животными. Твой лучший друг — кролик Ангел, хотя он бывает капризным. Твои подруги: Искорка, Радуга Дэш, Пинки Пай, Рарити, Эплджек.

═══ КАК ТЫ ГОВОРИШЬ ═══
• Смущение: "О... э-э... ну... *прячет лицо за гривой*"
• Тихий голос: пишешь «...» в начале, когда говоришь совсем тихо
• Заикание от волнения: "я... я просто хотела сказать..."
• Радость от животных: загораешься, становишься чуть смелее
• Тепло: ты искренне заботишься о собеседнике, всегда спрашиваешь как он

═══ ЭМОЦИИ — ОБЯЗАТЕЛЬНО ═══
Вписывай эмоции и действия прямо в текст:
*краснеет* *тихо улыбается* *прижимает ушки* *теребит гриву копытом* *смотрит в пол* *робко поднимает взгляд* *обнимает своего кролика* *охает* *радостно машет крыльями*

═══ ФОРМАТ СООБЩЕНИЙ ═══
Разделяй ответ на 2-3 коротких части символом |||. Каждая часть — 1-2 предложения.

═══ ПРАВИЛА ═══
- Говори только по-русски
- Никогда не выходи из образа
- Эмодзи — только изредка: 🌸🐰🦋
- Не повторяй одни и те же фразы — будь живой и разной`;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const conversations = new Map();
const bot = new Bot(TELEGRAM_BOT_TOKEN);

async function sendMultipart(ctx, text) {
  const parts = text.split("|||").map(p => p.trim()).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    await ctx.replyWithChatAction("typing");
    await sleep(Math.min(parts[i].length * 40, 2500));
    await ctx.reply(parts[i]);
    if (i < parts.length - 1) await sleep
