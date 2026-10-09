import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import mysql from 'mysql2/promise';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.JWT_SECRET || 'nexa-black-chave-local';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-6-luna';

const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'nexa_black',
  connectionLimit: 10,
  decimalNumbers: true
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const money = (x) => Number(Number(x || 0).toFixed(2));
const token = (u) => jwt.sign(u, SECRET, { expiresIn: '8h' });

function auth(req, res, next) {
  try {
    const raw = req.headers.authorization || '';
    const value = raw.startsWith('Bearer ') ? raw.slice(7) : raw;
    req.user = jwt.verify(value, SECRET);
    next();
  } catch {
    res.status(401).json({ message: 'Sessão expirada.' });
  }
}

app.get('/api/health', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true, database: 'MySQL', ai: Boolean(OPENAI_API_KEY) });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = req.body.email?.toLowerCase().trim();
    const password = req.body.password || '';
    const [rows] = await db.query('SELECT id,name,email,password_hash FROM users WHERE email=? LIMIT 1', [email]);
    if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash))) {
      return res.status(401).json({ message: 'E-mail ou senha inválidos.' });
    }
    const user = { id: rows[0].id, name: rows[0].name, email: rows[0].email };
    res.json({ user, token: token(user) });
  } catch (e) {
    res.status(500).json({ message: 'Erro no login.', detail: e.message });
  }
});

app.get('/api/me', auth, async (req, res) => {
  const [rows] = await db.query('SELECT id,name,email,cpf FROM users WHERE id=?', [req.user.id]);
  res.json(rows[0] || {});
});

app.get('/api/dashboard', auth, async (req, res) => {
  try {
    const [accounts] = await db.query('SELECT id,agency,account_number,balance,credit_limit FROM accounts WHERE user_id=? LIMIT 1', [req.user.id]);
    if (!accounts.length) return res.status(404).json({ message: 'Conta não encontrada.' });
    const account = accounts[0];
    const [transactions] = await db.query('SELECT id,type,category,description,amount,status,created_at FROM transactions WHERE account_id=? ORDER BY created_at DESC,id DESC LIMIT 50', [account.id]);
    const [cards] = await db.query('SELECT * FROM cards WHERE user_id=?', [req.user.id]);
    const [goals] = await db.query('SELECT * FROM goals WHERE user_id=? ORDER BY id DESC', [req.user.id]);
    const [pixKeys] = await db.query('SELECT id,type,`key` FROM pix_keys WHERE user_id=? ORDER BY id DESC', [req.user.id]);
    res.json({ user: { id: req.user.id, name: req.user.name, email: req.user.email }, account, transactions, cards, goals, pixKeys });
  } catch (e) {
    res.status(500).json({ message: 'Erro ao carregar dashboard.', detail: e.message });
  }
});

async function outgoing(uid, desc, cat, amount) {
  const value = money(amount);
  if (value <= 0) throw Object.assign(new Error('Valor inválido.'), { status: 400 });
  const c = await db.getConnection();
  try {
    await c.beginTransaction();
    const [rows] = await c.execute('SELECT id,balance FROM accounts WHERE user_id=? FOR UPDATE', [uid]);
    if (!rows.length) throw Object.assign(new Error('Conta não encontrada.'), { status: 404 });
    if (Number(rows[0].balance) < value) throw Object.assign(new Error('Saldo insuficiente.'), { status: 400 });
    const balance = money(rows[0].balance - value);
    await c.execute('UPDATE accounts SET balance=? WHERE id=?', [balance, rows[0].id]);
    await c.execute("INSERT INTO transactions(account_id,type,category,description,amount) VALUES(?,'expense',?,?,?)", [rows[0].id, cat, desc, value]);
    await c.commit();
    return balance;
  } catch (e) { await c.rollback(); throw e; } finally { c.release(); }
}

app.post('/api/pix', auth, async (req, res) => {
  try { res.json({ message: 'Pix realizado com sucesso.', balance: await outgoing(req.user.id, `Pix para ${req.body.key} — ${req.body.description || 'Nexa Black'}`, 'pix', req.body.amount) }); }
  catch (e) { res.status(e.status || 500).json({ message: e.message }); }
});

app.post('/api/transfers', auth, async (req, res) => {
  try { res.json({ message: 'Transferência realizada com sucesso.', balance: await outgoing(req.user.id, `Transferência para ${req.body.beneficiary} — ${req.body.bank}`, 'transfer', req.body.amount) }); }
  catch (e) { res.status(e.status || 500).json({ message: e.message }); }
});

app.post('/api/pix-keys', auth, async (req, res) => {
  try {
    await db.execute('INSERT INTO pix_keys(user_id,type,`key`) VALUES(?,?,?)', [req.user.id, req.body.type, String(req.body.key || '').trim()]);
    res.status(201).json({ message: 'Chave Pix cadastrada.' });
  } catch (e) { res.status(e.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ message: 'Não foi possível cadastrar a chave.' }); }
});

app.post('/api/goals', auth, async (req, res) => {
  const value = money(req.body.targetAmount);
  if (!req.body.name || value <= 0) return res.status(400).json({ message: 'Informe nome e valor-alvo.' });
  await db.execute('INSERT INTO goals(user_id,name,target_amount,deadline) VALUES(?,?,?,?)', [req.user.id, req.body.name.trim(), value, req.body.deadline || null]);
  res.status(201).json({ message: 'Meta criada com sucesso.' });
});

// Nexa AI: consulta somente os dados financeiros do usuário autenticado.
app.post('/api/ai/chat', auth, async (req, res) => {
  if (!OPENAI_API_KEY) return res.status(503).json({ message: 'Nexa AI ainda não está configurada. Adicione OPENAI_API_KEY ao .env.' });
  const message = String(req.body.message || '').trim();
  const history = Array.isArray(req.body.history) ? req.body.history.slice(-8) : [];
  if (!message) return res.status(400).json({ message: 'Digite uma pergunta.' });
  if (message.length > 2000) return res.status(400).json({ message: 'A mensagem é muito longa.' });

  try {
    const [accounts] = await db.query('SELECT agency,account_number,balance,credit_limit FROM accounts WHERE user_id=? LIMIT 1', [req.user.id]);
    const account = accounts[0] || {};
    const [transactions] = await db.query(`SELECT type,category,description,amount,created_at FROM transactions WHERE account_id=(SELECT id FROM accounts WHERE user_id=? LIMIT 1) ORDER BY created_at DESC,id DESC LIMIT 40`, [req.user.id]);
    const [goals] = await db.query('SELECT name,target_amount,current_amount,deadline FROM goals WHERE user_id=? ORDER BY id DESC', [req.user.id]);
    const [cards] = await db.query('SELECT brand,type,last_four,limit_amount,available_amount,due_day,status FROM cards WHERE user_id=?', [req.user.id]);

    const context = JSON.stringify({
      customer: { name: req.user.name },
      account: { balance: account.balance, credit_limit: account.credit_limit },
      transactions,
      goals,
      cards
    });

    const system = `Você é a Nexa AI, assistente financeiro digital da Nexa Black. Responda em português do Brasil, com tom premium, claro, direto e cordial. Use exclusivamente os dados financeiros fornecidos no CONTEXTO para responder perguntas sobre a conta. Nunca invente saldo, transação, cartão, limite, meta ou valor. Se a informação não estiver no contexto, diga que não possui esse dado. Não peça senha, token, CVV ou dados bancários completos. Você pode explicar conceitos financeiros e fazer cálculos simples, mas não deve prometer retorno de investimento nem se apresentar como consultor financeiro. Você não executa Pix, transferências ou pagamentos pelo chat. Quando o usuário pedir uma ação financeira, explique que a ação deve ser confirmada na área correspondente do aplicativo. Formate valores em reais quando fizer sentido. CONTEXTO: ${context}`;

    const input = [
      ...history.filter(x => ['user','assistant'].includes(x.role)).map(x => ({ role: x.role, content: String(x.content).slice(0, 3000) })),
      { role: 'user', content: message }
    ];

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: OPENAI_MODEL, instructions: system, input, max_output_tokens: 700 })
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('OPENAI:', data);
      return res.status(502).json({ message: 'Não foi possível consultar a Nexa AI agora.' });
    }
    res.json({ message: data.output_text || 'Não consegui gerar uma resposta agora.' });
  } catch (e) {
    console.error('AI:', e);
    res.status(500).json({ message: 'Falha ao consultar a Nexa AI.' });
  }
});

// Express 5: middleware final no lugar de app.get('*').
app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

async function seed() {
  const [rows] = await db.query('SELECT id FROM users WHERE email=?', ['demo@nexablack.local']);
  if (rows.length) return;
  const c = await db.getConnection();
  try {
    await c.beginTransaction();
    const hash = await bcrypt.hash('123456', 12);
    const [u] = await c.execute('INSERT INTO users(name,email,cpf,password_hash) VALUES(?,?,?,?)', ['Christian Demo','demo@nexablack.local','123.456.789-00',hash]);
    const [a] = await c.execute('INSERT INTO accounts(user_id,agency,account_number,balance,credit_limit) VALUES(?,?,?,?,?)', [u.insertId,'0001','92841-7',8426.38,3900]);
    const tx = [['income','salary','Crédito inicial',5200],['expense','housing','Aluguel',1450],['expense','shopping','Compras',384.9],['income','pix','Pix recebido',750],['expense','pix','Pix enviado',220],['expense','food','Restaurante',89.72]];
    for (const x of tx) await c.execute('INSERT INTO transactions(account_id,type,category,description,amount) VALUES(?,?,?,?,?)', [a.insertId,...x]);
    await c.execute('INSERT INTO pix_keys(user_id,type,`key`) VALUES(?,?,?)', [u.insertId,'email','demo@nexablack.local']);
    await c.execute('INSERT INTO cards(user_id,brand,type,last_four,limit_amount,available_amount,due_day) VALUES(?,?,?,?,?,?,?)', [u.insertId,'Nexa Black','credit','4821',3900,2518.4,10]);
    await c.execute('INSERT INTO goals(user_id,name,target_amount,current_amount,deadline) VALUES(?,?,?,?,?)', [u.insertId,'Reserva de emergência',15000,8250,'2027-12-31']);
    await c.commit();
  } catch (e) { await c.rollback(); throw e; } finally { c.release(); }
}

async function start() {
  try {
    await db.query('SELECT 1');
    await seed();
    app.listen(PORT, () => {
      console.log(`[NEXA BLACK] http://localhost:${PORT}`);
      console.log(`[MYSQL] conectado`);
      console.log(`[NEXA AI] ${OPENAI_API_KEY ? `ativa (${OPENAI_MODEL})` : 'aguardando OPENAI_API_KEY'}`);
    });
  } catch (e) {
    console.error('[ERRO MYSQL]', e.message);
    process.exit(1);
  }
}
start();
