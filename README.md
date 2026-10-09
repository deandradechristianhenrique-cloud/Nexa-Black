# Nexa Black — Node.js + Express + MySQL

Projeto acadêmico de banco digital fictício.

## Instalação
1. Instale Node.js 20+ e MySQL.
2. Execute `database/schema.sql` no MySQL Workbench.
3. Copie `.env.example` para `.env` e coloque a senha do MySQL em `DB_PASSWORD`.
4. Rode `npm install`.
5. Rode `npm start`.
6. Acesse http://localhost:3000

Conta demonstrativa: `demo@nexablack.local` / `123456`.

O sistema usa JWT, bcrypt, MySQL, saldo persistente, extrato, Pix simulado, transferências, chaves Pix, cartões e metas. Nenhuma operação movimenta dinheiro real.
