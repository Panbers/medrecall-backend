import express from "express";
import fetch from "node-fetch";
import pkg from "pg";
import dotenv from "dotenv";

const { Pool } = pkg;
dotenv.config();

// 🧩 Conexão com o banco (usa as variáveis do .env)
const pool = new Pool({
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  host: process.env.PG_HOST,
  port: process.env.PG_PORT,
  database: process.env.PG_DATABASE,
});

const router = express.Router();

// 🔔 Rota do webhook Mercado Pago
router.post("/", async (req, res) => {
  try {
    const evt = req.body;
    console.log("📩 Webhook recebido:", JSON.stringify(evt));

    // Filtra apenas eventos de pagamento
    const isPaymentEvent =
      evt?.type === "payment" ||
      (typeof evt?.action === "string" && evt.action.startsWith("payment."));
    if (!isPaymentEvent) {
      console.log("↩️ Ignorado (não é evento de pagamento)");
      return res.sendStatus(200);
    }

    // Obtém ID do pagamento
    const paymentId = evt?.data?.id || evt?.id;
    if (!paymentId) {
      console.warn("⚠️ Evento sem paymentId:", evt);
      return res.sendStatus(200);
    }
    console.log("🧾 ID do pagamento recebido:", paymentId);

    // Busca detalhes completos do pagamento na API do Mercado Pago
    const mpResp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
    });

    if (!mpResp.ok) {
      const txt = await mpResp.text();
      console.error("❌ Falha ao buscar pagamento:", mpResp.status, txt);
      return res.sendStatus(200); // evita reenvio em loop
    }

    const payment = await mpResp.json();
    console.log("💰 Pagamento:", {
      id: payment.id,
      status: payment.status,
      email: payment?.payer?.email,
      metadata: payment?.metadata,
    });

    // Só processa quando aprovado
    if (payment.status !== "approved") {
      console.log("⏳ Pagamento ainda não aprovado, ignorando.");
      return res.sendStatus(200);
    }

    // 🔎 Captura os dados reais do usuário
    const realEmail =
      payment?.metadata?.email ||
      payment?.payer?.email ||
      payment?.additional_info?.payer?.email ||
      null;

    const realUserId = payment?.metadata?.user_id || null;

    if (!realEmail && !realUserId) {
      console.warn("⚠️ Pagamento aprovado mas sem email/user_id. Ajuste metadata na criação.");
      return res.sendStatus(200);
    }

    // ✅ Atualiza assinatura no banco (prioridade: user_id)
    let result;
    if (realUserId) {
      result = await pool.query(
        `UPDATE users
           SET subscription_status = 'active',
               subscription_end_date = NOW() + INTERVAL '30 days'
         WHERE id = $1`,
        [realUserId]
      );
      console.log(`✅ Assinatura ativada para user_id: ${realUserId} (${realEmail || "sem email"})`);
    } else if (realEmail) {
      result = await pool.query(
        `UPDATE users
           SET subscription_status = 'active',
               subscription_end_date = NOW() + INTERVAL '30 days'
         WHERE email = $1`,
        [realEmail]
      );
      console.log(`✅ Assinatura ativada para: ${realEmail}`);
    }

    // 🧾 Confirma se o update realmente afetou uma linha
    if (result?.rowCount === 0) {
      console.warn("⚠️ Nenhum usuário foi atualizado. Verifique se o email/id existe no banco.");
    } else {
      console.log("🎯 Usuário atualizado com sucesso no PostgreSQL!");
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ Erro no webhook Mercado Pago:", err);
    return res.sendStatus(200); // evita reentrega infinita
  }
});

export default router;
