# WatchBot 🤖

A self-hosted web change tracker. Add URLs, set a polling interval, and WatchBot will notify you whenever the content changes — with an AI-generated summary of what changed.

---

## Features

- **Watch any URL** — monitors visible text content and detects changes on a configurable interval
- **AI change summaries** — uses Claude (Anthropic) to summarise what changed in plain English
- **AI resource finder** — describe a topic and get 30 curated URL suggestions to monitor
- **Real-time updates** — live push via Server-Sent Events; no page refresh needed
- **Browser notifications** — opt-in push notifications via Service Worker
- **Change history** — stacked per-tracker log of all detected changes with unread indicators
- **Lock changes** — pin individual change entries so they are never deleted or marked read
- **Expand / Collapse all** — one-click toggle for all change history panels from the toolbar
- **Drag-to-reorder** — organise your WatchBots in any order
- **User accounts** — JWT-based auth with registration and login
- **Super-admin panel** — manage users, roles, tracker limits, impersonate users for debugging
- **Dark mode** — follows system preference (Material-style UI)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Server | Node.js, Express |
| Database | SQLite (via `better-sqlite3`) |
| Auth | JWT in `httpOnly` cookies, bcrypt |
| Frontend | Vanilla JS, single-page (`public/index.html`) |
| AI | Anthropic Claude API (optional) |
| Push | Web Push / Service Worker |

---

## Requirements

- Node.js 18+
- An [Anthropic API key](https://console.anthropic.com/) (optional — AI summaries and resource finder are disabled gracefully without one)

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/gbot/watchbot.git
cd watchbot
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
PORT=3000
JWT_SECRET=your_long_random_secret_here
ANTHROPIC_API_KEY=your_anthropic_api_key_here   # optional
CHECK_CONCURRENCY=5                              # optional: max parallel checks (default 5)
```

> **`JWT_SECRET`** should be a long random string. Generate one with:
> `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

### 3. Start the server

```bash
npm start
```

Or with auto-reload for development:

```bash
npm run dev   # requires nodemon
```

Open [http://localhost:3000](http://localhost:3000).

---

## First Run

On first start, a **super-admin account** is automatically created. Check the server console output for the credentials. **Change the password immediately** via the account settings after logging in.

---

## Project Structure

```
watchbot/
├── server/
│   └── index.js        # Express server, all API routes, scheduler
├── public/
│   ├── index.html      # Single-page frontend application
│   ├── app.js          # Frontend logic
│   ├── style.css       # Styles
│   ├── sw.js           # Service Worker for browser notifications
│   └── icon.svg        # App icon
├── data/               # SQLite database (auto-created, git-ignored)
├── .env.example        # Environment variable template
└── package.json
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | HTTP port (default: `3000`) |
| `JWT_SECRET` | **Yes** | Secret key for signing JWT tokens |
| `ANTHROPIC_API_KEY` | No | Enables AI change summaries and resource finder |
| `CHECK_CONCURRENCY` | No | Max parallel tracker checks (default: `5`) |

---

## License

MIT
