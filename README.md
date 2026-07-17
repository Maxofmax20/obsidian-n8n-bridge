# n8n Bridge for Obsidian

Two-way bridge between your Obsidian vault and n8n, so an n8n workflow — or **Claude, via the Master agent's Obsidian MCP** — can read and write notes on any device where you install this plugin. Works on **desktop and mobile**.

---

## How it works

A phone (or any Obsidian app) can't be reached from the outside, so the plugin never listens for connections. Instead it **long-polls** n8n: each request holds open on the server until a job appears (returns instantly) or ~21 s elapse (returns empty), then repeats. This gives near-instant response while making very few requests when idle.

```
Claude / Master agent
      │  (MCP tool call: read_note, write_note, ...)
      ▼
Obsidian MCP server  ──►  enqueue-and-wait webhook  ──►  obsidian_jobs (n8n Data Table)
                                    ▲                              │  row: status=pending
                                    │ returns the result           ▼
                                    │                     ┌──── this plugin ────┐
                                    └─────────────────────┤ poll → run in vault │
                                          POST result     │  → POST result back │
                                                          └─────────────────────┘
```

1. Claude calls an MCP tool (e.g. `read_note`) targeting a **device name**.
2. The MCP server inserts a `pending` job and waits (up to ~60 s).
3. This plugin, polling every few seconds, picks the job up, runs it against the local vault, and POSTs the result.
4. The MCP server returns that result to Claude in the same call.

All traffic is plain HTTPS webhooks gated by a **shared secret**.

---

## Install

### Option A — Manual (works on desktop and mobile)

1. Create a folder in your vault:
   `<vault>/.obsidian/plugins/n8n-bridge/`
2. Copy these three files into it:
   - `main.js`
   - `manifest.json`
   - `styles.css` *(only if present — this plugin ships none, skip it)*
3. In Obsidian: **Settings → Community plugins**, enable **Restricted mode off**, then toggle **n8n Bridge** on.

On mobile: use a file manager / Obsidian Sync / Working Copy to place the same three files in the same path, then enable it the same way.

### Option B — BRAT (auto-updates)

1. Install the **BRAT** community plugin.
2. BRAT → *Add beta plugin* → point it at this repo.
3. Enable **n8n Bridge** in Community plugins.

---

## Configure (do this on every device)

Open **Settings → n8n Bridge**:

| Setting | What to enter |
|---|---|
| **n8n base URL** | `https://demos25.me` |
| **Device name** | A **unique** id for THIS device, e.g. `obsidian-phone`, `obsidian-laptop`. Claude targets a device by this exact name. Auto-filled with `obsidian-xxxxxx` on first run — rename it to something you'll recognise. |
| **Shared secret** | The SAME value on every device and in n8n (the value configured in your n8n workflows — keep it private, treat it like a password). ⚠️ The plugin auto-generates a random secret on first run; **replace it** with your shared value or the backend will reject every request. |
| **Poll gap (seconds)** | `2` is fine. This is **long-poll**: each request holds open on the server until a job appears (near-instant) or ~21 s pass, then repeats. So a low number here does **not** hammer n8n — it just sets the short pause between held-open requests. |

The poll/result/send webhook paths are pre-filled and don't need changing.

Once base URL + device name + secret are set, the plugin starts polling automatically. Use the **"n8n Bridge: Test connection (ping)"** command to confirm the device answers.

---

## Onboarding a new device (short version)

1. Install the plugin (Option A or B).
2. Set **base URL** = `https://demos25.me`.
3. Set a **unique device name**.
4. Set **shared secret** = your shared secret value (identical everywhere).
5. Ping to confirm.

That's it — nothing to register server-side. The device shows up simply by polling with a valid secret; Claude reaches it by the name you chose.

---

## Talking to it through Claude

Ask the Master agent things like:

- *"Read my Obsidian note Notes/todo.md on obsidian-laptop."*
- *"Append '- buy milk' to Notes/todo.md on my phone."*
- *"Search my vault for 'invoice' on obsidian-laptop."*

If a device is offline the tool returns a **timeout** (the job stays pending until the device next polls, or expires).

### Available actions (MCP tools)

`read_note` · `write_note` · `append_note` · `create_note` · `list_notes` · `search_vault` · `ping_device`

Paths are always **vault-relative** (e.g. `Notes/todo.md`; the `.md` is optional).

---

## Security notes

- Every request (poll, result, send) is rejected unless it carries the shared secret. Treat that secret like a password — rotate it in both the plugin settings and the n8n workflows if it ever leaks.
- The plugin only ever makes **outbound** HTTPS calls; nothing listens on the device.
- `create_note` never overwrites: if the path exists it picks a unique name. `write_note` **does** overwrite by design.

---

## Backend reference (n8n side)

| Piece | Path |
|---|---|
| Poll webhook | `POST/GET /webhook/obsidian-poll` |
| Result webhook | `POST /webhook/obsidian-result` |
| Enqueue-and-wait webhook | `POST /webhook/obsidian-enqueue` |
| Obsidian MCP server | `/mcp/Obsidian` |
| Master agent | consumes the Obsidian MCP as a tool |

Internal workflow / table IDs are intentionally omitted here; they live in your private n8n instance.

Job lifecycle in the jobs table: `pending → taken → done`.
