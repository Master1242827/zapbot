const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const CONFIG = {
  businessName:  process.env.BUSINESS_NAME  || "Minha Empresa",
  tone:          process.env.TONE           || "amigável e profissional",
  hours:         process.env.HOURS          || "Segunda a sexta, das 8h às 18h",
  services:      process.env.SERVICES       || "Atendimento ao cliente, vendas e suporte",
  extra:         process.env.EXTRA          || "",
};

const EVOLUTION_URL      = process.env.EVOLUTION_URL;
const EVOLUTION_APIKEY   = process.env.EVOLUTION_APIKEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE;
const GROQ_API_KEY       = process.env.GROQ_API_KEY;

const conversations = {};

function systemPrompt() {
  return `Você é um atendente virtual da empresa "${CONFIG.businessName}".
Tom de atendimento: ${CONFIG.tone}.
Horário de funcionamento: ${CONFIG.hours}.
Serviços: ${CONFIG.services}.
${CONFIG.extra ? `Informações extras: ${CONFIG.extra}` : ""}
Regras:
- Responda SEMPRE em português brasileiro
- Seja breve e direto (máximo 3 parágrafos curtos)
- Use emojis com moderação
- Se não souber algo, diga que vai verificar
- Se o cliente quiser falar com humano, escreva TRANSFERIR_HUMANO no final`;
}

async function askGroq(phoneNumber, userMessage) {
  if (!conversations[phoneNumber]) conversations[phoneNumber] = [];
  conversations[phoneNumber].push({ role: "user", content: userMessage });
  if (conversations[phoneNumber].length > 20) {
    conversations[phoneNumber] = conversations[phoneNumber].slice(-20);
  }

  const response = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt() },
        ...conversations[phoneNumber],
      ],
      max_tokens: 1000,
      temperature: 0.7,
    },
    {
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  const reply = response.data.choices[0].message.content;
  conversations[phoneNumber].push({ role: "assistant", content: reply });
  return reply;
}

async function sendWhatsApp(phone, message) {
  await axios.post(
    `${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
    { number: phone, text: message },
    { headers: { apikey: EVOLUTION_APIKEY, "Content-Type": "application/json" } }
  );
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.event !== "messages.upsert") return;
    if (body.data?.key?.fromMe) return;
    if (!body.data?.message) return;
    const phone = body.data.key.remoteJid.replace("@s.whatsapp.net", "");
    const message = body.data.message.conversation ||
      body.data.message.extendedTextMessage?.text || "";
    if (!message.trim()) return;
    console.log(`📩 [${phone}] ${message}`);
    const reply = await askGroq(phone, message);
    console.log(`🤖 [${phone}] ${reply}`);
    if (reply.includes("TRANSFERIR_HUMANO")) {
      const cleanReply = reply.replace("TRANSFERIR_HUMANO", "").trim();
      await sendWhatsApp(phone, cleanReply);
      delete conversations[phone];
      return;
    }
    await sendWhatsApp(phone, reply);
  } catch (err) {
    console.error("Erro no webhook:", err.message);
  }
});

app.get("/", (req, res) => {
  res.json({
    status: "✅ ZapBot online",
    business: CONFIG.businessName,
    ai: "Groq (gratuito)",
    conversations: Object.keys(conversations).length,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`⚡ ZapBot rodando na porta ${PORT}`);
  console.log(`🤖 IA: Groq (gratuito)`);
});
