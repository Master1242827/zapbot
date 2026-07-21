const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

const GROQ_API_KEY     = process.env.GROQ_API_KEY;
const EVOLUTION_URL    = process.env.EVOLUTION_URL;
const EVOLUTION_APIKEY = process.env.EVOLUTION_APIKEY;
const SUPABASE_URL     = process.env.SUPABASE_URL     || "https://fzfsjlvexftdllgzohac.supabase.co";
const SUPABASE_KEY     = process.env.SUPABASE_KEY     || "sb_publishable_9xMIUH8FdUXvyQ0o7GIfpQ_rXYe0Idp";
const MP_ACCESS_TOKEN  = process.env.MP_ACCESS_TOKEN; // Token privado do Mercado Pago (não é a chave pública)

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// Mapeia o valor pago para o nome do plano
function planFromAmount(amount) {
  if (amount >= 490) return "agency";
  if (amount >= 190) return "pro";
  if (amount >= 90)  return "basico";
  return "basico";
}

const PLAN_LIMITS = {
  basico:  { messages: 500,   transfer: false },
  pro:     { messages: 99999, transfer: true  },
  agency:  { messages: 99999, transfer: true  },
};

const conversations = {};

// ─── FUNÇÕES DE ATENDIMENTO (já existentes) ──────────────────────────────────
async function getClientConfig(instanceName) {
  try {
    const userIdPartial = instanceName.replace(/^zapbot-/i, "").trim().toLowerCase();
    const { data: profiles } = await sb.from("profiles").select("*");
    const profile = profiles?.find(p => {
      const idLower = p.id.toLowerCase();
      return idLower.startsWith(userIdPartial) || idLower.replace(/-/g, "").startsWith(userIdPartial.replace(/-/g, ""));
    });
    if (!profile) return null;
    const { data: botConfig } = await sb.from("bot_configs").select("*").eq("user_id", profile.id).single();
    return { profile, botConfig };
  } catch (e) {
    return null;
  }
}

// Verifica se o cliente tem acesso válido (trial ativo OU pagamento em dia)
function hasValidAccess(profile) {
  if (!profile.active) return false;
  if (profile.payment_status === "active") return true;
  if (profile.payment_status === "trial") {
    const trialEnd = new Date(profile.trial_ends_at);
    return trialEnd > new Date();
  }
  return false; // expired ou cancelled
}

async function checkMessageLimit(userId, plan) {
  const limit = PLAN_LIMITS[plan]?.messages || 500;
  if (limit >= 99999) return true;
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const { count } = await sb.from("messages").select("*", { count: "exact" })
    .eq("user_id", userId).eq("direction", "in").gte("created_at", startOfMonth.toISOString());
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
Segmento: ${botConfig?.niche || ""}.
Horário: ${botConfig?.hours || ""}.
Endereço: ${botConfig?.address || ""}.
Produtos/Serviços: ${botConfig?.services || ""}.
Faixa de preço: ${botConfig?.price_range || ""}.
Formas de pagamento: ${botConfig?.payment || ""}.
Frete/Entrega: ${botConfig?.shipping || ""}.
Prazo de entrega: ${botConfig?.delivery || ""}.
${botConfig?.pay_link ? `Link de pagamento/catálogo: ${botConfig.pay_link}` : ""}
${botConfig?.instagram ? `Instagram: @${botConfig.instagram}` : ""}
${botConfig?.website ? `Site: ${botConfig.website}` : ""}
${botConfig?.extra ? `Informações extras: ${botConfig.extra}` : ""}
Regras:
- Responda SEMPRE em português brasileiro
- Seja breve e direto (máximo 3 parágrafos curtos)
- Use emojis com moderação
- Se não souber algo, diga que vai verificar
- Se o cliente quiser falar com humano, escreva TRANSFERIR_HUMANO no final`;

  const response = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    { model: "llama-3.3-70b-versatile", messages: [{ role: "system", content: systemPrompt }, ...history], max_tokens: 1000, temperature: 0.7 },
    { headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" } }
  );
  const reply = response.data.choices[0].message.content;
  history.push({ role: "assistant", content: reply });
  return reply;
}

async function sendWhatsApp(instanceName, phone, message) {
  await axios.post(`${EVOLUTION_URL}/message/sendText/${instanceName}`,
    { number: phone, text: message },
    { headers: { apikey: EVOLUTION_APIKEY, "Content-Type": "application/json" } });
}

// ─── WEBHOOK DO WHATSAPP (mensagens dos clientes finais) ─────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.event !== "messages.upsert") return;
    if (body.data?.key?.fromMe) return;
    if (!body.data?.message) return;

    const instanceName = body.instance || body.data?.instanceName || "meu-bot";
    const phone = body.data.key.remoteJid.replace("@s.whatsapp.net", "");
    const message = body.data.message.conversation || body.data.message.extendedTextMessage?.text || "";
    if (!message.trim()) return;

    const client = await getClientConfig(instanceName);
    if (!client) { console.log(`⚠️ Cliente não encontrado: ${instanceName}`); return; }
    const { profile, botConfig } = client;

    // Verifica se o cliente tem acesso válido (pagou ou está em trial)
    if (!hasValidAccess(profile)) {
      console.log(`🔒 Acesso expirado para ${profile.name} (${profile.payment_status})`);
      return; // Não responde — cliente sem acesso não deve gastar créditos de IA
    }

    // Verifica se o robô está ligado (controlado pelo cliente no painel)
    if (profile.bot_enabled === false) {
      console.log(`⏸️ Robô desligado para ${profile.name} — mensagem recebida mas não respondida`);
      await sb.from("messages").insert({ user_id: profile.id, phone, direction: "in", content: message });
      return;
    }

    const withinLimit = await checkMessageLimit(profile.id, profile.plan);
    if (!withinLimit) {
      await sendWhatsApp(instanceName, phone, "Nosso atendimento automático atingiu o limite do mês. Em breve retornaremos! 😊");
      return;
    }

    const reply = await askGroq(instanceName, phone, message, botConfig);
    await sb.from("messages").insert({ user_id: profile.id, phone, direction: "in",  content: message });
    await sb.from("messages").insert({ user_id: profile.id, phone, direction: "out", content: reply });

    if (reply.includes("TRANSFERIR_HUMANO")) {
      const cleanReply = reply.replace("TRANSFERIR_HUMANO", "").trim();
      await sendWhatsApp(instanceName, phone, cleanReply);
      delete conversations[instanceName][phone];
      return;
    }
    await sendWhatsApp(instanceName, phone, reply);
  } catch (err) {
    console.error("Erro no webhook WhatsApp:", err.message);
  }
});

// ─── WEBHOOK DO MERCADO PAGO (pagamentos e assinaturas) ──────────────────────
app.post("/webhook/mercadopago", async (req, res) => {
  res.sendStatus(200); // Sempre responde 200 rápido pro Mercado Pago não reenviar
  try {
    const { type, data, action } = req.body;
    console.log("💰 Webhook Mercado Pago recebido:", type, action, JSON.stringify(data));

    // Tipo "payment" = pagamento avulso ou primeira cobrança de assinatura
    if (type === "payment" && data?.id) {
      const paymentRes = await axios.get(`https://api.mercadopago.com/v1/payments/${data.id}`, {
        headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` }
      });
      const payment = paymentRes.data;

      if (payment.status === "approved") {
        const email = payment.payer?.email;
        const amount = payment.transaction_amount;
        const plan = planFromAmount(amount);

        if (email) {
          const { data: profile } = await sb.from("profiles").select("*").eq("email", email).single();
          if (profile) {
            await sb.from("profiles").update({
              payment_status: "active",
              plan: plan,
              last_payment_at: new Date().toISOString(),
              active: true,
            }).eq("id", profile.id);
            console.log(`✅ Pagamento confirmado e plano ${plan} ativado para ${email}`);
          } else {
            console.log(`⚠️ Pagamento recebido de e-mail não cadastrado: ${email}`);
          }
        }
      }
    }

    // Tipo "subscription_preapproval" = eventos de assinatura recorrente
    if (type === "subscription_preapproval" && data?.id) {
      const subRes = await axios.get(`https://api.mercadopago.com/preapproval/${data.id}`, {
        headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` }
      });
      const sub = subRes.data;
      const email = sub.payer_email;

      if (email) {
        const { data: profile } = await sb.from("profiles").select("*").eq("email", email).single();
        if (profile) {
          let status = "trial";
          if (sub.status === "authorized") status = "active";
          if (sub.status === "cancelled" || sub.status === "paused") status = "cancelled";

          const amount = sub.auto_recurring?.transaction_amount || 0;
          const plan = planFromAmount(amount);

          await sb.from("profiles").update({
            payment_status: status,
            plan: status === "active" ? plan : profile.plan,
            mp_subscription_id: sub.id,
            active: status !== "cancelled",
          }).eq("id", profile.id);
          console.log(`🔄 Assinatura atualizada para ${email}: ${status}`);
        }
      }
    }
  } catch (err) {
    console.error("Erro no webhook Mercado Pago:", err.response?.data || err.message);
  }
});

// ─── CHECKOUT TRANSPARENTE: cria a cobrança (cartão, Pix ou boleto) ──────────
app.post("/create-payment", async (req, res) => {
  try {
    const { token, payment_method_id, issuer_id, installments, payer, transaction_amount, plan, description } = req.body;

    if (!payment_method_id || !transaction_amount || !payer?.email) {
      return res.status(400).json({ error: "Dados de pagamento incompletos." });
    }

    const payload = {
      transaction_amount: Number(transaction_amount),
      description: description || `ZapBot - Plano ${plan || ""}`,
      payment_method_id,
      payer,
      notification_url: "https://zapbot-production-be1c.up.railway.app/webhook/mercadopago",
      external_reference: plan || "",
    };
    if (token) payload.token = token;
    if (installments) payload.installments = Number(installments);
    if (issuer_id) payload.issuer_id = issuer_id;

    const idempotencyKey = `${payer.email}-${Date.now()}`;
    const mpRes = await axios.post("https://api.mercadopago.com/v1/payments", payload, {
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": idempotencyKey,
      },
    });

    const p = mpRes.data;

    // Se já aprovou na hora (cartão de crédito costuma responder na hora), ativa direto
    // — o webhook também vai confirmar em paralelo, sem problema duplicar.
    if (p.status === "approved" && payer.email) {
      const planName = plan || planFromAmount(p.transaction_amount);
      const { data: profile } = await sb.from("profiles").select("*").eq("email", payer.email).single();
      if (profile) {
        await sb.from("profiles").update({
          payment_status: "active",
          plan: planName,
          last_payment_at: new Date().toISOString(),
          active: true,
        }).eq("id", profile.id);
      }
    }

    res.json({
      status: p.status,
      status_detail: p.status_detail,
      id: p.id,
      qr_code: p.point_of_interaction?.transaction_data?.qr_code || null,
      qr_code_base64: p.point_of_interaction?.transaction_data?.qr_code_base64 || null,
      ticket_url: p.transaction_details?.external_resource_url || p.point_of_interaction?.transaction_data?.ticket_url || null,
    });
  } catch (err) {
    console.error("Erro ao criar pagamento:", err.response?.data || err.message);
    res.status(400).json({ error: err.response?.data?.message || "Erro ao processar pagamento." });
  }
});

// ─── ROTINA DIÁRIA: expira trials vencidos ───────────────────────────────────
async function expireTrials() {
  try {
    const { data: expiring } = await sb.from("profiles")
      .select("*")
      .eq("payment_status", "trial")
      .lt("trial_ends_at", new Date().toISOString());

    for (const profile of expiring || []) {
      await sb.from("profiles").update({ payment_status: "expired" }).eq("id", profile.id);
      console.log(`⏰ Trial expirado para ${profile.name} (${profile.email})`);
    }
  } catch (e) {
    console.error("Erro ao expirar trials:", e.message);
  }
}
// Roda a cada 1 hora
setInterval(expireTrials, 60 * 60 * 1000);
expireTrials(); // roda uma vez ao iniciar

app.get("/", (req, res) => {
  res.json({ status: "✅ ZapBot online", ai: "Groq (gratuito)", payments: "Mercado Pago conectado" });
});

// ─── MENSAGENS AGENDADAS ──────────────────────────────────────────────────────
function getInstanceNameFromUserId(userId) {
  return `zapbot-${userId.substring(0, 8)}`;
}

async function processScheduledMessages() {
  try {
    const now = new Date().toISOString();
    const { data: due } = await sb
      .from("scheduled_messages")
      .select("*")
      .eq("status", "pending")
      .lte("send_at", now);

    for (const sched of due || []) {
      try {
        const instanceName = getInstanceNameFromUserId(sched.user_id);
        await sendWhatsApp(instanceName, sched.phone, sched.message);
        await sb.from("scheduled_messages")
          .update({ status: "sent", sent_at: new Date().toISOString() })
          .eq("id", sched.id);
        await sb.from("messages").insert({
          user_id: sched.user_id, phone: sched.phone, direction: "out", content: sched.message,
        });
        console.log(`📅 Mensagem agendada enviada para ${sched.phone}`);
      } catch (err) {
        await sb.from("scheduled_messages").update({ status: "failed" }).eq("id", sched.id);
        console.error(`❌ Falha ao enviar agendamento ${sched.id}:`, err.message);
      }
    }
  } catch (e) {
    console.error("Erro ao processar agendamentos:", e.message);
  }
}
// Roda a cada 1 minuto
setInterval(processScheduledMessages, 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`⚡ ZapBot rodando na porta ${PORT}`));
