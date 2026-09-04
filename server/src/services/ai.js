/* ==========================================================================
   Manara — AI reply generator for the subscription chat (gamer / club).
   Pluggable: if LLM_API_KEY + LLM_BASE_URL are set it calls an OpenAI-
   compatible chat completion endpoint. Otherwise it falls back to a local
   rule-based Arabic reply so the whole paywall flow works end-to-end
   offline. Swap the provider by changing ONLY this file.
   ========================================================================== */
require("dotenv").config();

const PREVIEW_CHARS = 90;

function buildSystemPrompt(user, type) {
  if (type === "club") {
    return "You are Manara's assistant for sports clubs. The club name is \"" + (user.name || "") +
      "\". Reply in Arabic, short, actionable, about scouting, transfers and managing player applications.";
  }
  return "You are Manara's assistant for athletes. The player's name is \"" + (user.name || "") +
    "\". Reply in Arabic, short, motivating and actionable, about choosing clubs, improving skills and preparing highlights.";
}

async function viaLlm(messageText, user, type) {
  const key = process.env.LLM_API_KEY;
  const base = process.env.LLM_BASE_URL || "https://api.openai.com/v1";
  if (!key) return null;
  const res = await fetch(base.replace(/\/$/, "") + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({
      model: process.env.LLM_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: buildSystemPrompt(user, type) },
        { role: "user", content: messageText }
      ],
      max_tokens: 260
    })
  });
  if (!res.ok) return null;
  const data = await res.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return text ? String(text).trim() : null;
}

// Rule-based fallback so the system is fully functional without a provider.
function mockReply(messageText, user, type) {
  const name = user.name || "صديقي";
  const body = String(messageText || "").trim();
  const topics = body.split(/\s+/).slice(0, 4).join(" ");
  if (type === "club") {
    return "مرحباً " + name + " 👋\n\n" +
      "وصلتنا رسالتك عن \"" + topics + "\". نظام منارة يمنحك الوصول الفوري لملفات اللاعبين المعتمدة " +
      "(الشهادات، الوثائق الطبية، الفيديوهات والإحصائيات). أنصحك بالتواصل المباشر مع ٣ لاعبين الأسبوع القادم " +
      "لمقارنة ملفاتهم، ثم اختيار الأنسب لمركزك قبل أي انتقال.\n\n" +
      "أقترح أن تبدأ الآن بفلترة المراكز التي تحتاجها في صفحة اللاعبين — فريقنا جاهز لمساعدتك في كل خطوة.";
  }
  return "مرحباً " + name + " ⚽\n\n" +
    "فهمت رسالتك عن \"" + topics + "\". نصيحتي الأولى: حسّن ملفك بفيديو تدريبي قصير لمركزك، " +
    "واهتم بمعدل انتظامك في التمارين — الأندية تبحث عن الانضباط قبل الموهبة.\n\n" +
    "التقارير الحالية من منارة تشير إلى أن الأكاديميات الكبرى تبحث عن لاعبين تحت ٢١ سنة بمستواك. " +
    "الخطوة التالية التي أقترحها هي تجهيز رسالة تواصل احترافية لأقرب نادٍ مناسب، وأستطيع مساعدتك بها الآن.";
}

// Generates the AI reply for a chat. Returns { text, provider: "llm"|"mock" }.
async function generateReply(messageText, user, type) {
  const fromLlm = await viaLlm(messageText, user, type).catch(() => null);
  if (fromLlm) return { text: fromLlm, provider: "llm" };
  return { text: mockReply(messageText, user, type), provider: "mock" };
}

function preview(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length <= PREVIEW_CHARS ? clean : clean.slice(0, PREVIEW_CHARS) + "…";
}

module.exports = { generateReply, preview };