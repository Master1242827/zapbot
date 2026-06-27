const express = require("express");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

const GROQ_API_KEY     = process.env.GROQ_API_KEY;
const EVOLUTION_URL    = process.env.EVOLUTION_URL;
const EVOLUTION_APIKEY = process.env.EVOLUTION_APIKEY;
const SUPABASE_URL     = process.env.SUPABASE_URL     || "https://fzfsjlvexftdllgzohac.supabase.co";
const SUPABASE_KEY     = process.env.SUPABASE_KEY     || "sb_publishable_9xMIUH8FdUXvyQ0o7GIfpQ_rXYe0Idp";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// Limites por plano
const PLAN_LIMITS = {
  basico:  { messages: 500,   transfer: false },
  pro:     { messages: 99999, transfer: true  },
  agency:  { messages: 99999, transfer: true  },
};

const conversations = {};

// Busca configuração do cliente pelo número da instância
async function getClientConfig(instanceName) {
  try {
    // Busca o user_id pelo nome da instância (formato: zapbot-USERID8CHARS)
    const userId8 = instanceName.replace("zapbot-", "");
    const { data: profiles } = await sb.from("profiles").select("*");
    const profile = profiles?.find(p => p.id.startsWith(userId8));
    if (!profile) return null;

    const { data: botConfig } = await sb.from("bot_configs").select("*").eq("user_id", profile.id).single();
    return { profile, botConfig };
  } catch (e) {
    return null;
  }
}

// Verifica se modo automático está ativo (salvo no banco futuramente)
async function isAutoMode(userId) {
  // Por enquanto sempre true — no futuro salvar no banco
  return true;
}

// Verifica limite de mensagens do mês
async function checkMessageLimit(userId, plan) {
  const limit = PLAN_LIMITS[plan]?.messages || 500;
  if (limit >= 99999) return true;

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const { count } = await sb.from("messages")
    .select("*", { count: "exact" })
    .eq("user_id", userId)
    .eq("direction", "in")
    .gte("created_at", startOfMonth.toISOString());

  return (count || 0) < limit;
}

async function askGroq(instanceName, phoneNumber, userMessage, botConfig) {
  if (!conversations[instanceName]) conversations[instanceName] = {};
  if (!conversations[instanceName][phoneNumber]) conversations[instanceName][phoneNumber] = [];

  const history = conversations[instanceName][phoneNumber];
  history.push({ role: "user", content: userMessage });
  if (history.length > 20) history.splice(0, history.length - 20);

  const systemPrompt = `Você é um atendente virtual da empresa "${botConfig?.business_name || "Empresa"}".
Tom de atendimento: ${botConfig?.tone || "amigável e profissional"}.
Horário de funcionamento: ${botConfig?.hours || "Seg a Sex, 8h às 18h"}.
Serviços: ${botConfig?.services || "Atendimento ao cliente"}.
${botConfig?.extra ? `Informações extras: ${botConfig.extra}` : ""}
Regras:
- Responda SEMPRE em português brasileiro
- Seja breve e direto (máximo 3 parágrafos curtos)
- Use emojis com moderação
- Se não souber algo, diga que vai verificar
- Se o cliente quiser falar com humano, escreva TRANSFERIR_HUMANO no final da mensagem`;

  const response = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "system", content: systemPrompt }, ...history],
      max_tokens: 1000,
      temperature: 0.7,
    },
    { headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" } }
  );

  const reply = response.data.choices[0].message.content;
  history.push({ role: "assistant", content: reply });
  return reply;
}

async function sendWhatsApp(instanceName, phone, message) {
  await axios.post(
    `${EVOLUTION_URL}/message/sendText/${instanceName}`,
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

    const instanceName = body.instance || body.data?.instanceName || "meu-bot";
    const phone = body.data.key.remoteJid.replace("@s.whatsapp.net", "");
    const message = body.data.message.conversation ||
      body.data.message.extendedTextMessage?.text || "";
    if (!message.trim()) return;

    console.log(`📩 [${instanceName}] [${phone}] ${message}`);

    // Busca config do cliente
    const client = await getClientConfig(instanceName);
    if (!client) {
      console.log(`⚠️ Cliente não encontrado para instância: ${instanceName}`);
      return;
    }

    const { profile, botConfig } = client;

    // Verifica modo automático
    const auto = await isAutoMode(profile.id);
    if (!auto) {
      console.log(`⏸️ Modo manual ativo para ${instanceName}`);
      return;
    }

    // Verifica limite de mensagens
    const withinLimit = await checkMessageLimit(profile.id, profile.plan);
    if (!withinLimit) {
      await sendWhatsApp(instanceName, phone, "Nosso atendimento automático atingiu o limite do mês. Em breve retornaremos! 😊");
      return;
    }

    // Gera resposta
    const reply = await askGroq(instanceName, phone, message, botConfig);
    console.log(`🤖 [${instanceName}] ${reply}`);

    // Salva mensagens no banco
    await sb.from("messages").insert({ user_id: profile.id, phone, direction: "in",  content: message });
    await sb.from("messages").insert({ user_id: profile.id, phone, direction: "out", content: reply });

    // Verifica transferência para humano
    if (reply.includes("TRANSFERIR_HUMANO")) {
      const cleanReply = reply.replace("TRANSFERIR_HUMANO", "").trim();
      await sendWhatsApp(instanceName, phone, cleanReply);
      delete conversations[instanceName][phone];
      return;
    }

    await sendWhatsApp(instanceName, phone, reply);
  } catch (err) {
    console.error("Erro no webhook:", err.message);
  }
});

app.get("/", (req, res) => {
  res.json({ status: "✅ ZapBot online", ai: "Groq (gratuito)", conversations: Object.keys(conversations).length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`⚡ ZapBot rodando na porta ${PORT}`));
