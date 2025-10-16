# Fibz

A Discord bot leveraging Google Cloud Vertex AI (Gemini 2.5 Pro) for advanced conversation, content understanding, image/video/audio recognition, voice message comprehension, and more — with enterprise-grade security and a vastly improved UX.

## Features

- **Now powered by 2.5 Gemini Pro!** (via Vertex AI)
- **Uses Google Cloud Vertex AI Platform**
- **Enterprise-grade security and authentication**
- **WAY better user experience and interface**
- **Super duper advanced smart Image/video/audio and file recognition** (supports images, videos, audios, PDFs, docx, pptx; can understand voice messages; full multimodal support; **can’t write code at the moment**)
- **PERSISTENT, PERMANENT, REFERENCEABLE MEMORY!!!** (Fibz remembers and can look up archives when needed)
- **Can recognize different people within the same conversation!** (multi-user attribution/awareness)
- **Core Identity and Rules** (configurable behavior guardrails)
- **Updated privacy and consent protocol**
- **Personalized personalities!** (per user, channel, or server)
- **Improved and foolproofed button-based UI**
- **Ability to override the 2000 character limit when instructed to** (auto-splitting/attachments)
- **Server and channel-wide chat history** options
- **Admin controls** for blacklisting/whitelisting users
- **Downloadable conversation/message history**
- **Multiple AI tools:** integrated tool use (e.g., Google Search)
- **Status monitoring** (RAM, CPU, and reset timer)
- Tons of other features built over **270+ hours** — vastly superior everything than before!

---

## Getting Started

### Prerequisites

- Node.js v20+ recommended
- Discord bot token ([create here](https://discord.com/developers/applications))
- Google Cloud project with Vertex AI enabled  
  - Service Account with appropriate IAM roles (e.g., Vertex AI User)  
  - Local credentials via `GOOGLE_APPLICATION_CREDENTIALS` (or Application Default Credentials)

### Setup

1. **Clone the repo:**
    ```bash
    git clone <YOUR_REPO_URL>
    cd Fibz
    ```

2. **Install dependencies:**
    ```bash
    npm install
    ```

3. **Configure environment variables:**
    - Copy `example.env` to `.env`
    - Fill in your tokens and Vertex AI config:
      ```
      DISCORD_BOT_TOKEN=your_discord_bot_token

      # Google Cloud / Vertex AI
      GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service_account.json
      VERTEX_PROJECT_ID=your_gcp_project_id
      VERTEX_LOCATION=us-central1
      VERTEX_MODEL=gemini-2.5-pro
      ```

4. **Start the bot:**
    ```bash
    npm start
    ```

---

## Usage

- **Invite the bot to your Discord server.**
- Use `/settings` to configure personal or channel preferences, privacy/consent, memory, and personalities.
- Use `/server_settings` for server-wide admin controls (core identity/rules, chat history defaults, etc.).
- Upload supported files, images/videos/audios, or **voice messages**, then ask the bot about them.
- Ask Fibz to “go long” when you need **responses beyond 2000 characters** (it will auto-split or attach as needed).
- Use slash commands:
    - `/respond_to_all enabled:true|false` – Bot responds to every message in a channel
    - `/clear_memory` – Clear your personal conversation history
    - `/toggle_channel_chat_history enabled:true|false [instructions]` – Channel-wide conversation
    - `/blacklist user:@user` – Prevent a user from using the bot
    - `/whitelist user:@user` – Remove a user from the blacklist
    - `/status` – Show system status

---

## Customization

- Modify `config.js` to change **core identity and rules**, default personalities/activities/colors, feature toggles, and privacy defaults.
- Persistent data (chat history, **long-term memory/archives**, settings, blacklists, etc.) is stored in the `config` (and/or designated data) directory. Consider external/cloud storage for durability.

---

## Admin & Security

- **Enterprise-grade security** using Google Cloud Vertex AI with IAM-scoped service accounts and encrypted transport/storage.
- **Updated privacy and consent protocol:** per-user and per-server controls for memory, retention, and data use.
- Only server admins can use admin commands (blacklist, whitelist, server settings).
- Blacklisted users cannot interact with the bot.

---

## Notes

- Fibz maintains **persistent, referenceable memory**. Use `/clear_memory` or adjust settings if you prefer ephemeral sessions.
- The bot stores chat history/settings locally by default. For production, use durable/cloud storage.
- **Code generation is currently disabled** (“can’t write code at the moment”).
- **Do not commit your `.env` with secrets.**
