// 🧩 DEPENDÊNCIAS BÁSICAS
import express from "express";
import webhookRoutes from "./api/webhook.js";

import cors from "cors";
import bcrypt from "bcryptjs";

import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import pkg from "pg";
//import Stripe from "stripe";
import { MercadoPagoConfig, Payment } from "mercadopago";
import fetch from "node-fetch"; // se ainda não tiver


dotenv.config();
const { Pool } = pkg;
const app = express();

// ⚠️ O Stripe exige raw body no webhook, então tratamos antes do express.json()
app.use((req, res, next) => {
  if (req.originalUrl === "/api/stripe-webhook") {
    next();
  } else {
    express.json()(req, res, next);
  }
});
app.use("/api/webhook", webhookRoutes);

app.use(cors());


// 🔗 CONEXÃO COM POSTGRES
export const pool = new Pool({
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  host: process.env.PG_HOST,
  port: process.env.PG_PORT,
  database: process.env.PG_DATABASE,
  ssl: { rejectUnauthorized: false } // 👈 obrigatório no Supabase
});

// 🔐 FUNÇÃO JWT
function verifyToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ message: "Token ausente" });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: "Token inválido" });
    req.user = user;
    next();
  });
}

// 🧾 REGISTRO E LOGIN DE USUÁRIO
app.post("/api/register", async (req, res) => {
  try {
    const { email, password } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, subscription_status, created_at)
       VALUES ($1, $2, 'inactive', NOW()) RETURNING id, email`,
      [email, hashed]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Erro ao registrar:", err);
    res.status(500).json({ message: "Erro no registro." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query("SELECT * FROM users WHERE email=$1", [email]);
    if (result.rows.length === 0) return res.status(404).json({ message: "Usuário não encontrado" });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ message: "Senha incorreta" });

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: "1h" });
    res.json({ token, user });
  } catch (err) {
    res.status(500).json({ message: "Erro no login." });
  }
});


// 💳 PAGAMENTOS (Stripe e Mercado Pago)
//const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
//mercadopago.configure({ access_token: process.env.MP_ACCESS_TOKEN });


const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

// Criar sessão Stripe
/*
app.post("/api/create-checkout-session", verifyToken, async (req, res) => {
  if (process.env.PAYMENT_PROVIDER !== "stripe")
    return res.status(400).json({ message: "Stripe desativado." });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: "https://seusite.com/sucesso",
      cancel_url: "https://seusite.com/cancelado",
      customer_email: req.user.email,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("Erro Stripe:", err);
    res.status(500).json({ message: "Erro ao criar sessão Stripe." });
  }
});
*/
// Criar pagamento Mercado Pago
app.post("/api/create-preference", verifyToken, async (req, res) => {
  if (process.env.PAYMENT_PROVIDER !== "mercadopago")
    return res.status(400).json({ message: "Mercado Pago desativado." });

  try {
    const preference = {
      items: [{ title: "Assinatura MedRecall", quantity: 1, unit_price: 19.9 }],
      payer: { email: req.user.email },
      back_urls: {
        success: "https://seusite.com/sucesso",
        failure: "https://seusite.com/erro",
      },
      auto_return: "approved",
      notification_url: "https://anissa-pinfire-legibly.ngrok-free.dev/api/webhook/mercadopago",
    };
    const response = await mercadopago.preferences.create(preference);
    res.json({ init_point: response.body.init_point });
  } catch (err) {
    console.error("Erro MP:", err);
    res.status(500).json({ message: "Erro ao criar pagamento Mercado Pago." });
  }
});
app.post("/api/payments/create", verifyToken, async (req, res) => {
  try {
    console.log("🧠 Body recebido:", req.body);

    const { plan_name, amount } = req.body;
    const userId = req.user.id;

    console.log("📦 Criando pagamento Mercado Pago:", {
      plan_name,
      price: amount,
      email: req.user.email,
    });

    const payment = await new Payment(mpClient).create({
  body: {
    transaction_amount: Number(amount),
    description: plan_name,
    payment_method_id: "pix",
    payer: {
      email: req.user.email || "teste@medrecall.com",
    },
    metadata:{
      email: req.user.email,
      user_id: req.user.id
    }
  },
});


    console.log("✅ Pagamento criado:", payment);
    res.json(payment);
  } catch (error) {
    console.error("❌ Erro ao criar pagamento:", error);
    res.status(500).json({ message: "Erro ao criar pagamento no Mercado Pago." });
  }
});


// ✅ WEBHOOK STRIPE
// 
/*
app.post("/api/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    if (event.type === "invoice.payment_succeeded") {
      const email = event.data.object.customer_email;
      await pool.query(
        `UPDATE users SET subscription_status='active', subscription_end_date=NOW() + INTERVAL '30 days' WHERE email=$1`,
        [email]
      );
      console.log(`✅ Stripe: assinatura ativada para ${email}`);
    }
    res.json({ received: true });
  } catch (err) {
    console.error("Erro no webhook Stripe:", err);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});
*/


// ✅ WEBHOOK MERCADO PAGO
// 🔔 Webhook de notificações do Mercado Pago
app.post("/api/webhook/mercadopago", async (req, res) => {
  try {
    const evento = req.body;
    console.log("📩 Webhook recebido:", evento);

    // Exemplo: confirmar pagamento
    if (evento.action === "payment.created" || evento.action === "payment.updated") {
      const paymentId = evento.data.id;

      // Buscar detalhes do pagamento
      const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` }
      });

      const payment = await response.json();
      console.log("💰 Detalhes do pagamento:", payment);

      if (payment.status === "approved") {
        // Atualiza o usuário no banco
        await pool.query(
          `UPDATE users SET subscription_status = 'active' WHERE email = $1`,
          [payment.payer.email]
        );
        console.log(`✅ Assinatura ativada para ${payment.payer.email}`);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Erro no webhook do Mercado Pago:", error);
    res.sendStatus(500);
  }
});
// 🚀 Carrega todos os dados do usuário logado
app.get('/api/initial-data', verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    console.log(`📦 Carregando dados do usuário ID: ${userId}`);

    const [folders, decks, flashcards, planners, files] = await Promise.all([
      pool.query('SELECT * FROM folders WHERE user_id = $1 AND deleted_at IS NULL', [userId]),
      pool.query('SELECT * FROM decks WHERE user_id = $1 AND deleted_at IS NULL', [userId]),
      pool.query('SELECT * FROM flashcards WHERE user_id = $1 AND deleted_at IS NULL', [userId]),
      pool.query('SELECT * FROM planners WHERE user_id = $1 AND deleted_at IS NULL', [userId]),
      pool.query('SELECT * FROM files WHERE user_id = $1 AND deleted_at IS NULL', [userId]),
    ]);

    console.log(`📂 Pastas encontradas: ${folders.rows.length}`);
    console.log(`📘 Decks encontrados: ${decks.rows.length}`);
    console.log(`💬 Flashcards encontrados: ${flashcards.rows.length}`);
    console.log(`📅 Planners encontrados: ${planners.rows.length}`);
    console.log(`📁 Files encontrados: ${files.rows.length}`);

    // 🔍 Aqui é onde geralmente o erro acontece
    const decksWithCards = decks.rows.map(deck => {
      const cards = flashcards.rows
        .filter(card => Number(card.deck_id) === Number(deck.id))
        .map(card => ({
          id: card.id,
          question: card.front,
          answer: card.back,
          commentary: card.commentary || '',
          srsLevel: card.srs_level || 0,
          nextReviewDate: card.next_review_date,
          reviewHistory: []
        }));
      return { ...deck, cards };
    });

    console.log(`✅ Retornando ${decksWithCards.length} decks prontos.`);

    res.json({
      folders: folders.rows,
      decks: decksWithCards,
      flashcards: flashcards.rows,
      planners: planners.rows,
      files: files.rows,
    });
  } catch (err) {
    console.error('❌ Erro ao carregar dados iniciais:', err);
    res.status(500).json({ message: 'Erro ao carregar dados do usuário.', error: err.message });
  }
});

// 🆕 Criar novo deck
app.post("/api/decks", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, type } = req.body;

    if (!name || !type)
      return res.status(400).json({ message: "Nome e tipo são obrigatórios." });

    const result = await pool.query(
      `INSERT INTO decks (user_id, name, type, created_at, folder_id)
       VALUES ($1, $2, $3, NOW(), NULL)
       RETURNING *`,
      [userId, name, type]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Erro ao criar deck:", err);
    res.status(500).json({ message: "Erro ao criar deck." });
  }
});

// 📦 Listar decks
app.get("/api/decks", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT * FROM decks
       WHERE user_id = $1
       AND deleted_at IS NULL
       ORDER BY created_at DESC`,
      [userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Erro ao buscar decks:", err);
    res.status(500).json({ message: "Erro ao buscar decks." });
  }
});

// 🗂️ Criar nova pasta
app.post("/api/folders", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    let { name, type } = req.body;

    if (!name) return res.status(400).json({ message: "Nome da pasta é obrigatório." });
    if (!type || (type !== "flashcards" && type !== "questions")) type = "flashcards";

    const result = await pool.query(
      `INSERT INTO folders (user_id, name, type, created_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING *`,
      [userId, name, type]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("❌ Erro ao criar pasta:", err);
    res.status(500).json({ message: "Erro ao criar pasta." });
  }
});

// 📋 Listar pastas
app.get("/api/folders", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      `SELECT * FROM folders
       WHERE user_id = $1
       AND deleted_at IS NULL
       ORDER BY created_at DESC`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Erro ao buscar pastas:", err);
    res.status(500).json({ message: "Erro ao buscar pastas." });
  }
});

// 🆕 Criar novo flashcard
app.post("/api/flashcards", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { deck_id, front, back, srs_level, next_review_date } = req.body;

    if (!deck_id || !front || !back)
      return res.status(400).json({ message: "Campos obrigatórios ausentes." });

    const result = await pool.query(
      `INSERT INTO flashcards (user_id, deck_id, front, back, srs_level, next_review_date, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING *`,
      [userId, deck_id, front, back, srs_level || 0, next_review_date || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Erro ao criar flashcard:", err);
    res.status(500).json({ message: "Erro ao criar flashcard." });
  }
});

// ✏️ Atualizar flashcard existente
app.put("/api/flashcards/:id", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { front, back, srs_level, next_review_date } = req.body;

    const result = await pool.query(
      `UPDATE flashcards
       SET front = $1, back = $2, srs_level = $3, next_review_date = $4
       WHERE id = $5 AND user_id = $6
       RETURNING *`,
      [front, back, srs_level, next_review_date, id, userId]
    );

    if (result.rows.length === 0)
      return res.status(404).json({ message: "Flashcard não encontrado." });

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Erro ao atualizar flashcard:", err);
    res.status(500).json({ message: "Erro ao atualizar flashcard." });
  }
});

// ❌ Deletar flashcard
app.delete("/api/flashcards/:id", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const result = await pool.query(
      `DELETE FROM flashcards WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, userId]
    );

    if (result.rows.length === 0)
      return res.status(404).json({ message: "Flashcard não encontrado." });

    res.json({ message: "Flashcard removido com sucesso.", id });
  } catch (err) {
    console.error("Erro ao excluir flashcard:", err);
    res.status(500).json({ message: "Erro ao excluir flashcard." });
  }
});



// 🔚 ROTA TESTE
app.get("/", (req, res) => res.send("✅ API MedRecall rodando com Stripe e Mercado Pago"));

// 🚀 SERVIDOR
const PORT = 3000;
app.listen(PORT, () => console.log(`🚀 Servidor em http://localhost:${PORT}`));

