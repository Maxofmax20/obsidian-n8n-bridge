# 1.7.0 — Whole-vault two-way sync

Our own sync engine (no third-party plugin). Two-way sync of the **entire vault**
— notes **and** attachments/binaries — against our `vault-sync` server.

- Newest change wins by modified time (mtime).
- Binary-safe: images/PDFs/any attachment travel as base64, chunked so large files
  don't blow the call stack.
- Deletes propagate both ways via server tombstones (no resurrection).
- Background loop with mobile resume triggers (Android + iOS); also a **"Sync vault now"**
  command and a Sync-now button in settings.
- Files land as real, inspectable files on the server's disk.

## Setup
Settings → n8n Bridge → **Whole-vault sync**: enable it, set the Sync server URL
(`https://vaultsync.demos25.me`) and the sync secret. Use the **same URL and secret on
every device**.
