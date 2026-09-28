# Builder Bob: Telegram alignment prototype

This is the conversation slice in [design.md](../design.md): project name and files → file coverage → up to five questions → bounded direction checks → recap → correction → explicit approval → saved direction. Saved directions remain open for review. Project execution comes later.

## Deploy to the existing Render service

The `psanan23/builder-bob-ping-pong` GitHub repository now contains the source files, tests, and server entry point. Update the matching source files there through a pull request; Render deploys `main` and keeps the same public URL and Ping/Pong page. The older `upload-to-github/` bundle remains as a local build artifact and is not the deployed entry point.

The service needs these **Render → builder-bob-ping-pong → Environment** variables before the Telegram flow will work:

These go on the **Render web service**, not in GitHub's “Environments” page. In Render, choose **Add variable** and enter each name and value there.

| Name | Value |
| --- | --- |
| `OPENAI_API_KEY` | Your existing OpenAI API key. Keep it in Render; never put it in GitHub or chat. |
| `TELEGRAM_BOT_TOKEN` | Your existing BotFather token. Keep it in Render. |
| `DATABASE_URL` | The Postgres connection string from a Neon database. Keep it in Render. |
| `TELEGRAM_WEBHOOK_SECRET` | A random string of letters, numbers, `_`, or `-`. In Terminal, `openssl rand -hex 32` makes one. Keep it in Render. |
| `PUBLIC_BASE_URL` | `https://builder-bob-ping-pong.onrender.com` |
| `ALLOWED_TELEGRAM_USER_IDS` | Your Telegram numeric user ID, then any other enrolled tester IDs separated by commas. See below. |

`OPENAI_MODEL` is optional; the default is `gpt-4.1-mini`. Render's existing build and start commands (`npm install`, `npm start`) and `/health` endpoint still apply. The app registers its HTTPS Telegram webhook at startup.

### Create the database

1. Sign in to [Neon](https://console.neon.tech/) and create a Free Postgres project. Use a nearby region if offered.
2. Open the project's **Connect** panel and copy the connection string. It starts with `postgresql://` and includes a password, so keep it private.
3. Paste it as `DATABASE_URL` in the Render service's Environment page. Save the variable there. Do not paste it into Telegram, GitHub, this chat, or a local Markdown file.

The database stores conversation state, extracted file facts, question and answer history, verified direction with source links and checked dates, recap versions, and immutable approved snapshots. It does **not** store uploaded file bytes. Postgres is required: the app will not silently use Render's temporary disk.

To replace an **unapproved** test project in the same private chat, send `/new` and choose **Start new project**, or reply with that exact text. The bot replaces its working project details after that choice. Earlier Telegram messages remain visible in the chat. An approved direction cannot be replaced with this command.

### Get your Telegram ID

If you do not know your numeric Telegram ID, leave `ALLOWED_TELEGRAM_USER_IDS` unset for the first deployment. Send `/start` to your bot in a private chat. It will reply with your ID but will not start the AI flow. Add that ID to `ALLOWED_TELEGRAM_USER_IDS` in Render, save, and send `/start` again. Unknown users cannot start a project or use the AI.

## Live test with fictional material

1. In the private bot chat, send `/start`.
2. Send `Make a balcony reading corner` as the project name.
3. Upload [balcony-notes.txt](../examples/balcony-notes.txt) directly as a file and tap **Files ready**.
4. Check that the bot says it read the file before it asks no more than five numbered questions. Answer briefly, using the numbers.
5. Review the five-part recap. Ask one natural question about its reasoning, then correct one actual assumption or preference. Review the full revised recap.
6. Tap **Approve this recap** only when the latest version matches your goal and approach. Send `/saved` to retrieve the exact approved recap.
7. Restart or redeploy the Render service, send `/saved` again, and check that the same approved version returns.

The initial fictional run has finished. A real test may use a short summary approved by Bon; do not upload identity scans for this test. Approval saves direction only; the bot has no tools for purchasing, booking, applying, messaging third parties, or making a detailed action plan.

Record the observed conversation and Bon's review in [alignment-test-evidence.md](../alignment-test-evidence.md). Do not claim the live test passed from local tests alone.

## Develop locally

Run `npm install` and `npm test` in this folder. `npm run build:upload` still generates the older standalone bundle, but the current GitHub deployment uses the source files. Local tests use a fake Telegram client, fake AI responses, and a memory store; deployed code requires Postgres.


## Review a saved direction

- `/saved` shows the latest approved text exactly as it was saved.
- `/review` opens it for questions or corrections. You can also simply type a correction after approval.
- A material correction produces a new proposed version. The old approval stays saved and cannot approve the revision.
- `/history` lists earlier approvals; `/saved 1` retrieves version 1.
- `/sources` explains the public evidence supporting the current direction.

Before a recap, Builder Bob discovers prerequisites and sequence, checks material public uncertainties with official/primary sites, and checks the proposed ownership. Public lookup receives generalized questions, not raw files or identifying details. Each lookup is limited to four web-tool calls and stops once direction is supported. Ordinary preferences and physical measurements do not trigger public research. Unresolved requirements remain visible with a next check; an unavailable AI/tool request pauses approval and offers `/retry`.

No new secrets or private-account integrations are required. Web search uses the existing OpenAI Responses API key. The default model supports the hosted `web_search` tool. A direction check, recap draft and semantic review each have a 60-second request timeout; semantic repair is limited to one regeneration. Checked direction is reused on a retry with unchanged inputs. Local tests cover transport and state behavior with mocks; live model accuracy still needs Bon's review.


If the API rejects the newer web tool with a tool-validation error, the adapter makes one attempt with OpenAI's documented preview compatibility tool. That variant does not accept domain filters, so known authority domains are enforced on the saved source evidence. The lookup remains bounded, with the same non-identifying scope and approval gate. Authentication/quota/transport failures do not trigger this fallback.
