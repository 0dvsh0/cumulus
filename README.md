# Cumulus — AI Website Readiness Auditor

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-green.svg)](https://nodejs.org/)
[![Playwright](https://img.shields.io/badge/Playwright-Chromium-45ba4b.svg)](https://playwright.dev/)
[![Checks](https://img.shields.io/badge/Audit%20Checks-33%20Rules-blueviolet.svg)](#the-33-checks)
[![GitHub Pages](https://img.shields.io/badge/Live%20Demo-GitHub%20Pages-brightgreen.svg)](https://0dvsh0.github.io/cumulus/)

> **Cumulus** is an open-source, production-ready website auditor that evaluates how easily AI agents can discover, access, understand, and purchase from your website.

### 🌐 Live Links
- **Online Demonstration (GitHub Pages):** [https://0dvsh0.github.io/cumulus/](https://0dvsh0.github.io/cumulus/)
- **Interactive Check Registry & Documentation:** [https://0dvsh0.github.io/cumulus/docs.html](https://0dvsh0.github.io/cumulus/docs.html)
- **Interactive Sample Report:** [https://0dvsh0.github.io/cumulus/report.html?id=sample](https://0dvsh0.github.io/cumulus/report.html?id=sample)

It tests websites across four core categories:
- **Discovery:** Can agents find key pages, documentation, products, pricing, and machine-readable hints (`robots.txt`, sitemaps, `llms.txt`, JSON-LD)?
- **Access:** Can agents retrieve information across server HTML (SSR) and rendered DOM (CSR)? Does the site present bot challenges (Cloudflare, CAPTCHAs) or user-agent blocking?
- **Usability:** Can agents understand content, headings, forms, landmarks, and navigate critical user journeys (locating documentation and signup)?
- **Payments:** Can agents discover pricing, extract plan names and prices, understand offers, and reach checkout interfaces safely?

---

## Key Features

1. **Dual-Lens Architecture (Static + Headless Browser):**
   - Evaluates initial raw server HTML (fetch-only agents like Claude or ChatGPT retrieval).
   - Renders the full DOM in headless Chromium with strict default-deny network sandboxing.
   - Measures content disparity and JavaScript dependency.

2. **Real Browser Task Simulation:**
   - Navigates through actual DOM elements to find pricing (`P1`), extract plan tiers and amounts (`P2`), reach checkout interfaces (`P5`), verify plan links (`P6`), locate signup forms (`U8`), and discover documentation (`U9`).
   - Safe and read-only: never enters personal data, never submits forms, never charges cards.

3. **Transparent 33-Check Audit Model:**
   - 33 independently defined checks across 4 categories (Critical, High, Medium, Low severity).
   - Distinguishes **Pass**, **Partial**, **Fail**, **Blocked**, **Inconclusive**, **Error**, and **N/A**.
   - Transparent scoring out of 100 with strict coverage tracking — untested conditions are never treated as confirmed failures.

4. **Actionable Remediation & Downloadable Fix Kit:**
   - Detailed dashboard with evidence snippets, DOM paths, and HTTP statuses.
   - Generates a downloadable fix kit `.zip` archive containing a prioritized `README.md` and individual Markdown instruction files (`01-A1-...md`, etc.) with concrete acceptance criteria and verification commands.

5. **Programmatic Access (REST API + Model Context Protocol):**
   - Full REST API (`/api/v1/audits`, `/events`, `/findings`, `/fix-kit`, `/history`, `/meta`, `/openapi.json`).
   - Native Model Context Protocol (MCP) server over HTTP (`POST /mcp`) and stdio (`npm run mcp`), giving autonomous AI agents direct access to run audits, stream progress, read findings, and retrieve remediation instructions.

6. **Rigorous Security & Trust:**
   - Netguard SSRF defense: blocks loopback, private IPv4/IPv6 CIDR ranges, link-local cloud metadata (AWS, GCP, Azure), embedded credentials, and non-standard ports.
   - Chromium network resolver locked with `--host-resolver-rules` and per-request route interception.
   - Origin cool-down and global concurrency limits.

---

## Architecture Overview

```
                      ┌──────────────────────────────────────────────┐
                      │              User Interfaces                 │
                      │  Landing (/) · Report (/report/:id) · /docs  │
                      └──────────────────────┬───────────────────────┘
                                             │ HTTP / SSE
                      ┌──────────────────────▼───────────────────────┐
                      │            Cumulus Express Server            │
                      │   REST API (/api/v1)   │   MCP (/mcp)        │
                      └──────────────────────┬───────────────────────┘
                                             │
                      ┌──────────────────────▼───────────────────────┐
                      │                 AuditEngine                  │
                      │   Stage pipeline · Progress event emitter    │
                      └──────┬───────────────────────────────┬───────┘
                             │                               │
              ┌──────────────▼──────────────┐ ┌──────────────▼──────────────┐
              │          safeFetch          │ │        runBrowserPhase      │
              │  DNS pinned, SSRF-guarded   │ │   Headless Chromium sandbox │
              │  robots.txt, raw HTML, crawl│ │   Rendering + 5 Agent Tasks │
              └──────────────┬──────────────┘ └──────────────┬──────────────┘
                             │                               │
                             └───────────────┬───────────────┘
                                             │
                      ┌──────────────────────▼───────────────────────┐
                      │        Check Registry (33 Checks)            │
                      │  Discovery · Access · Usability · Payments   │
                      └──────────────────────┬───────────────────────┘
                                             │
                      ┌──────────────────────▼───────────────────────┐
                      │        Scoring Engine & Fix Kit              │
                      │  Weighted score · Coverage % · ZIP generator │
                      └──────────────────────────────────────────────┘
```

---

## Quickstart

### Prerequisites
- Node.js ≥ 20
- Playwright Chromium (`npm run postinstall` installs automatically)

### Installation & Run

```bash
# 1. Install dependencies & Playwright browsers
npm install

# 2. Run test suite
npm test

# 3. Start server
npm start
# Server listens at http://localhost:3000
```

Open `http://localhost:3000` in your browser to audit any public website.

---

## REST API Reference

All REST endpoints live under `/api/v1` (with legacy `/api` aliases supported):

| Endpoint | Method | Description |
|---|---|---|
| `/api/v1/audits` | `POST` | Start an audit. Body: `{"url": "https://example.com"}`. Returns `202 Accepted` with audit ID. |
| `/api/v1/audits` | `GET` | List recent audits. Query: `?limit=15`, `?host=example.com`. |
| `/api/v1/audits/:id` | `GET` | Get audit status and complete report when finished. |
| `/api/v1/audits/:id/events` | `GET` | Server-Sent Events (SSE) live progress stream (`progress` and `done` events). |
| `/api/v1/audits/:id/findings` | `GET` | Filterable findings with evidence. `?detail=1` includes complete remediation steps. |
| `/api/v1/audits/:id/fix-kit` | `GET` | Download the remediation ZIP archive. |
| `/api/v1/audits/:id` | `DELETE` | Cancel a running audit. |
| `/api/v1/history?host=...` | `GET` | Retrieve score history for a specific host. |
| `/api/v1/meta` | `GET` | Full check catalog (33 checks), weights, category definitions, and limits. |
| `/api/v1/openapi.json` | `GET` | OpenAPI 3.1 specification. |

---

## Model Context Protocol (MCP)

Cumulus provides a native Model Context Protocol server, enabling LLMs and AI coding assistants (such as Claude Desktop, Cursor, or Antigravity) to audit websites programmatically.

### Running over stdio

```bash
npm run mcp
# or: node scripts/mcp-stdio.mjs http://localhost:3000/mcp
```

### Config for AI Assistants

Add to your MCP client configuration (`claude_desktop_config.json`, etc.):

```json
{
  "mcpServers": {
    "cumulus": {
      "command": "node",
      "args": ["d:/coding/hackathon/culumus/scripts/mcp-stdio.mjs"],
      "env": {
        "CUMULUS_MCP_URL": "http://localhost:3000/mcp"
      }
    }
  }
}
```

### MCP Tools Provided:
- `start_audit`: Initiates an audit of a URL.
- `get_audit_status`: Polls progress, percent complete, and active stage.
- `get_report`: Returns overall score, category scores, coverage, and check results.
- `list_findings`: Returns failed and partial checks with evidence.
- `get_fix_kit`: Returns the fix kit download URL and instructions.
- `check_catalogue`: Returns all 33 check specifications and weighting model.

---

## Scoring Model & Coverage

Category and overall scores use transparent, published formulas:
- **Status Credits:** Pass = 1.0, Partial = 0.5, Fail = 0.0.
- **Severity Weights:** Critical = 5, High = 3, Medium = 2, Low = 1.
- **Category Score:** `Σ(weight × credit) ÷ Σ(weight of evaluated checks) × 100`.
- **Overall Score:** Arithmetic mean of evaluated category scores.
- **Coverage:** `Σ(weight of evaluated checks) ÷ Σ(weight of applicable checks) × 100`.
- **Unverified Statuses:** Blocked, Inconclusive, and Error are never penalized as failures; they are clearly distinguished in open items.

---

## License

MIT © Cumulus Contributors.
