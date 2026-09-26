# Builder Bob Telegram alignment test

This branch adds the Telegram conversation while keeping the public Ping/Pong page. The bot accepts one project name and directly uploaded files, asks up to five context questions, revises a recap, and saves the exact approved direction. It does not execute the project.

## Render variables

### Create the database first

1. In [Neon](https://console.neon.tech/), create a free project. Choose a nearby region if Neon offers one.
2. Open the project's **Connection Details**. Copy its Postgres connection string (the one beginning `postgresql://`); use the pooled connection option if offered. Keep the full string private.
3. In Render, open **builder-bob-ping-pong → Environment**. Add a variable named `DATABASE_URL` and paste the full connection string as its value. Do not put it in a GitHub Environment or repository file.

You do not need to create tables yourself. The bot creates its own tables when it starts.

Add these to the **Render web service** Environment page, not to GitHub Environments or the repository:

- `OPENAI_API_KEY` — existing OpenAI API key
- `TELEGRAM_BOT_TOKEN` — BotFather token
- `DATABASE_URL` — Neon Postgres connection string
- `TELEGRAM_WEBHOOK_SECRET` — random letters/numbers, for example from `openssl rand -hex 32`
- `PUBLIC_BASE_URL` — `https://builder-bob-ping-pong.onrender.com`
- `ALLOWED_TELEGRAM_USER_IDS` — comma-separated enrolled tester IDs

Keep all secret values out of GitHub and Telegram. If your Telegram ID is unknown, leave `ALLOWED_TELEGRAM_USER_IDS` unset for one deploy and send `/start` to the bot in a private chat. It will show your ID without starting the AI flow. Add that ID in Render, save, and send `/start` again.

Render build command: `npm install`. Start command: `npm start`. Health check: `/health`. The app requires the database and registers the webhook at startup.

## Fictional live test

Send `/start`, then `Make a balcony reading corner`. Upload `examples/balcony-notes.txt`, tap **Files ready**, answer the numbered questions, ask about a recap assumption, correct it, and approve only the latest recap. Use `/saved` before and after a service restart to confirm that the same version returns.

To replace an **unapproved** test project in the same private chat, send `/new` and choose **Start new project**, or reply with that exact text. The bot replaces its current working details; earlier Telegram messages remain in the chat. This command does not replace an approved direction.

Run `npm test` locally for the state-machine and storage checks. The tests use fake AI and Telegram responses; they do not establish a live result.
