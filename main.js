var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => N8nBridgePlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var DEFAULT_SETTINGS = {
  baseUrl: "https://demos25.me",
  pollPath: "/webhook/obsidian-poll",
  resultPath: "/webhook/obsidian-result",
  sendPath: "/webhook/obsidian-send",
  device: "",
  secret: "",
  pollSeconds: 5,
  enablePolling: true,
  notifyOnJob: true
};
var N8nBridgePlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.pollTimer = null;
    this.polling = false;
    // re-entrancy guard
    this.statusEl = null;
  }
  async onload() {
    await this.loadSettings();
    let dirty = false;
    if (!this.settings.device) {
      this.settings.device = "obsidian-" + randomToken(6);
      dirty = true;
    }
    if (!this.settings.secret) {
      this.settings.secret = randomToken(24);
      dirty = true;
    }
    if (dirty)
      await this.saveSettings();
    this.addSettingTab(new N8nBridgeSettingTab(this.app, this));
    this.statusEl = this.addStatusBarItem();
    this.setStatus("idle");
    this.addCommand({
      id: "send-active-note-to-n8n",
      name: "Send current note to n8n",
      callback: () => this.sendActiveNote()
    });
    this.addCommand({
      id: "poll-n8n-now",
      name: "Check n8n for jobs now",
      callback: () => this.pollOnce(true)
    });
    this.addCommand({
      id: "test-n8n-connection",
      name: "Test n8n connection",
      callback: () => this.testConnection()
    });
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof import_obsidian.TFile && file.extension === "md") {
          menu.addItem(
            (i) => i.setTitle("Send to n8n").setIcon("workflow").onClick(() => this.sendNoteFile(file))
          );
        }
      })
    );
    this.app.workspace.onLayoutReady(() => this.startPolling());
  }
  onunload() {
    this.stopPolling();
  }
  /* ---------------- settings persistence ---------------- */
  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    );
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  /* ---------------- poll loop ---------------- */
  startPolling() {
    this.stopPolling();
    if (!this.settings.enablePolling) {
      this.setStatus("paused");
      return;
    }
    const ms = Math.max(2, this.settings.pollSeconds) * 1e3;
    this.pollTimer = this.registerInterval(
      window.setInterval(() => this.pollOnce(false), ms)
    );
    this.setStatus("idle");
    this.pollOnce(false);
  }
  stopPolling() {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
  setStatus(state) {
    if (!this.statusEl)
      return;
    const map = {
      idle: "n8n \u2713",
      busy: "n8n \u2026",
      paused: "n8n \u23F8",
      error: "n8n \u26A0"
    };
    this.statusEl.setText(map[state]);
  }
  /**
   * One poll cycle: ask n8n for pending jobs for this device, run each,
   * and post the result back. `manual` controls whether we toast "no jobs".
   */
  async pollOnce(manual) {
    if (this.polling)
      return;
    if (!this.settings.enablePolling && !manual)
      return;
    if (!this.configOk()) {
      if (manual)
        new import_obsidian.Notice("n8n Bridge: fill in base URL, device and secret first.");
      return;
    }
    this.polling = true;
    try {
      const url = this.trimBase() + this.settings.pollPath + `?device=${encodeURIComponent(this.settings.device)}&secret=${encodeURIComponent(this.settings.secret)}`;
      const resp = await (0, import_obsidian.requestUrl)({
        url,
        method: "GET",
        throw: false
      });
      if (resp.status < 200 || resp.status >= 300) {
        this.setStatus("error");
        if (manual)
          new import_obsidian.Notice(`n8n Bridge: poll failed (HTTP ${resp.status}).`);
        return;
      }
      const jobs = this.parseJobs(resp.json);
      if (!jobs.length) {
        this.setStatus("idle");
        if (manual)
          new import_obsidian.Notice("n8n Bridge: no pending jobs.");
        return;
      }
      this.setStatus("busy");
      for (const job of jobs) {
        const result = await this.runJob(job);
        await this.postResult(result);
        if (this.settings.notifyOnJob) {
          new import_obsidian.Notice(
            `n8n: ${job.action}${job.path ? " " + job.path : ""} \u2192 ${result.ok ? "ok" : "error"}`
          );
        }
      }
      this.setStatus("idle");
    } catch (e) {
      this.setStatus("error");
      if (manual)
        new import_obsidian.Notice("n8n Bridge: poll error \u2014 " + errMsg(e));
      console.error("n8n Bridge poll error", e);
    } finally {
      this.polling = false;
    }
  }
  parseJobs(body) {
    var _a;
    if (!body)
      return [];
    const raw = (_a = body.jobs) != null ? _a : body;
    if (Array.isArray(raw))
      return raw.filter((j) => j && j.action);
    if (raw && raw.action)
      return [raw];
    return [];
  }
  /* ---------------- job executor ---------------- */
  async runJob(job) {
    var _a, _b, _c, _d;
    const base = {
      id: job.id,
      device: this.settings.device,
      ok: false,
      action: job.action,
      path: job.path
    };
    try {
      switch (job.action) {
        case "ping":
          return { ...base, ok: true, data: { pong: true, vault: this.app.vault.getName() } };
        case "read_note": {
          const file = this.requireFile(job.path);
          const content = await this.app.vault.read(file);
          return { ...base, ok: true, data: { content, path: file.path } };
        }
        case "write_note": {
          const path = this.requirePath(job.path);
          const content = (_a = job.content) != null ? _a : "";
          const file = this.app.vault.getAbstractFileByPath(path);
          if (file instanceof import_obsidian.TFile) {
            await this.app.vault.modify(file, content);
          } else {
            await this.ensureFolder(path);
            await this.app.vault.create(path, content);
          }
          return { ...base, ok: true, data: { written: content.length, path } };
        }
        case "append_note": {
          const path = this.requirePath(job.path);
          const add = (_b = job.content) != null ? _b : "";
          const file = this.app.vault.getAbstractFileByPath(path);
          if (file instanceof import_obsidian.TFile) {
            await this.app.vault.append(file, add.startsWith("\n") ? add : "\n" + add);
          } else {
            await this.ensureFolder(path);
            await this.app.vault.create(path, add);
          }
          return { ...base, ok: true, data: { appended: add.length, path } };
        }
        case "create_note": {
          let path = this.requirePath(job.path);
          path = await this.uniquePath(path);
          await this.ensureFolder(path);
          await this.app.vault.create(path, (_c = job.content) != null ? _c : "");
          return { ...base, ok: true, path, data: { path } };
        }
        case "list_notes": {
          const files = this.app.vault.getMarkdownFiles();
          const scope = job.folder ? (0, import_obsidian.normalizePath)(job.folder) : "";
          const list = files.filter((f) => scope ? f.path.startsWith(scope) : true).map((f) => ({ path: f.path, name: f.basename, mtime: f.stat.mtime })).sort((a, b) => b.mtime - a.mtime);
          return { ...base, ok: true, data: { count: list.length, notes: list.slice(0, 500) } };
        }
        case "search_vault": {
          const q = ((_d = job.query) != null ? _d : "").toLowerCase();
          if (!q)
            throw new Error("search_vault requires a query");
          const files = this.app.vault.getMarkdownFiles();
          const hits = [];
          for (const f of files) {
            const text = await this.app.vault.cachedRead(f);
            const idx = text.toLowerCase().indexOf(q);
            if (idx >= 0) {
              const start = Math.max(0, idx - 60);
              hits.push({
                path: f.path,
                excerpt: text.slice(start, idx + q.length + 60).replace(/\s+/g, " ").trim()
              });
              if (hits.length >= 50)
                break;
            }
          }
          return { ...base, ok: true, data: { count: hits.length, hits } };
        }
        default:
          throw new Error("unknown action: " + job.action);
      }
    } catch (e) {
      return { ...base, ok: false, error: errMsg(e) };
    }
  }
  /* ---------------- result push ---------------- */
  async postResult(result) {
    var _a, _b, _c;
    const payload = {
      id: result.id,
      device: result.device,
      secret: this.settings.secret,
      ok: result.ok,
      action: result.action,
      path: (_a = result.path) != null ? _a : "",
      result: result.ok ? typeof result.data === "string" ? result.data : JSON.stringify((_b = result.data) != null ? _b : "") : (_c = result.error) != null ? _c : "error"
    };
    try {
      await (0, import_obsidian.requestUrl)({
        url: this.trimBase() + this.settings.resultPath,
        method: "POST",
        contentType: "application/json",
        headers: { "x-bridge-secret": this.settings.secret },
        body: JSON.stringify(payload),
        throw: false
      });
    } catch (e) {
      console.error("n8n Bridge: failed to post result", e);
    }
  }
  /* ---------------- manual push ---------------- */
  async sendActiveNote() {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      new import_obsidian.Notice("n8n Bridge: no active markdown note.");
      return;
    }
    await this.sendNoteFile(file);
  }
  async sendNoteFile(file) {
    if (!this.configOk()) {
      new import_obsidian.Notice("n8n Bridge: configure base URL, device and secret first.");
      return;
    }
    try {
      const content = await this.app.vault.read(file);
      const resp = await (0, import_obsidian.requestUrl)({
        url: this.trimBase() + this.settings.sendPath,
        method: "POST",
        contentType: "application/json",
        headers: { "x-bridge-secret": this.settings.secret },
        body: JSON.stringify({
          device: this.settings.device,
          path: file.path,
          name: file.basename,
          content
        }),
        throw: false
      });
      if (resp.status >= 200 && resp.status < 300) {
        new import_obsidian.Notice(`n8n Bridge: sent "${file.basename}".`);
      } else {
        new import_obsidian.Notice(`n8n Bridge: send failed (HTTP ${resp.status}).`);
      }
    } catch (e) {
      new import_obsidian.Notice("n8n Bridge: send error \u2014 " + errMsg(e));
    }
  }
  async testConnection() {
    if (!this.configOk()) {
      new import_obsidian.Notice("n8n Bridge: fill in base URL, device and secret first.");
      return;
    }
    const url = this.trimBase() + this.settings.pollPath + `?device=${encodeURIComponent(this.settings.device)}&secret=${encodeURIComponent(this.settings.secret)}&ping=1`;
    try {
      const resp = await (0, import_obsidian.requestUrl)({ url, method: "GET", throw: false });
      if (resp.status >= 200 && resp.status < 300) {
        new import_obsidian.Notice("n8n Bridge: connection OK \u2713");
        this.setStatus("idle");
      } else {
        new import_obsidian.Notice(`n8n Bridge: HTTP ${resp.status} from n8n.`);
        this.setStatus("error");
      }
    } catch (e) {
      new import_obsidian.Notice("n8n Bridge: cannot reach n8n \u2014 " + errMsg(e));
      this.setStatus("error");
    }
  }
  /* ---------------- helpers ---------------- */
  configOk() {
    return !!(this.settings.baseUrl && this.settings.device && this.settings.secret);
  }
  trimBase() {
    return this.settings.baseUrl.replace(/\/+$/, "");
  }
  requireFile(path) {
    const p = this.requirePath(path);
    const f = this.app.vault.getAbstractFileByPath(p);
    if (!(f instanceof import_obsidian.TFile))
      throw new Error("note not found: " + p);
    return f;
  }
  requirePath(path) {
    if (!path)
      throw new Error("path is required");
    let p = (0, import_obsidian.normalizePath)(path);
    if (!p.endsWith(".md"))
      p += ".md";
    return p;
  }
  async uniquePath(path) {
    if (!this.app.vault.getAbstractFileByPath(path))
      return path;
    const dot = path.lastIndexOf(".");
    const stem = path.slice(0, dot);
    const ext = path.slice(dot);
    let i = 1;
    while (this.app.vault.getAbstractFileByPath(`${stem} ${i}${ext}`))
      i++;
    return `${stem} ${i}${ext}`;
  }
  async ensureFolder(filePath) {
    const slash = filePath.lastIndexOf("/");
    if (slash <= 0)
      return;
    const dir = filePath.slice(0, slash);
    if (!this.app.vault.getAbstractFileByPath(dir)) {
      await this.app.vault.createFolder(dir).catch(() => {
      });
    }
  }
};
var N8nBridgeSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "n8n Bridge" });
    containerEl.createEl("p", {
      text: "This device polls n8n for read/write jobs and can push the current note. Give every device a UNIQUE name but the SAME secret, and register both in n8n.",
      cls: "setting-item-description"
    });
    new import_obsidian.Setting(containerEl).setName("n8n base URL").setDesc("Root of your n8n instance, no trailing slash.").addText(
      (t) => t.setPlaceholder("https://demos25.me").setValue(this.plugin.settings.baseUrl).onChange(async (v) => {
        this.plugin.settings.baseUrl = v.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Device name").setDesc("Unique id for THIS device. Claude targets a device by this name.").addText(
      (t) => t.setPlaceholder("obsidian-phone").setValue(this.plugin.settings.device).onChange(async (v) => {
        this.plugin.settings.device = v.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Shared secret").setDesc("Same value on every device and in n8n. Gates all requests.").addText((t) => {
      t.inputEl.type = "password";
      t.setValue(this.plugin.settings.secret).onChange(async (v) => {
        this.plugin.settings.secret = v.trim();
        await this.plugin.saveSettings();
      });
    }).addExtraButton(
      (b) => b.setIcon("refresh-cw").setTooltip("Generate a new secret").onClick(async () => {
        this.plugin.settings.secret = randomToken(24);
        await this.plugin.saveSettings();
        this.display();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Enable background polling").setDesc("When off, only manual 'Check n8n for jobs now' works.").addToggle(
      (t) => t.setValue(this.plugin.settings.enablePolling).onChange(async (v) => {
        this.plugin.settings.enablePolling = v;
        await this.plugin.saveSettings();
        this.plugin.startPolling();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Poll interval (seconds)").setDesc("How often to check n8n for jobs. Higher = less battery/data.").addText(
      (t) => t.setValue(String(this.plugin.settings.pollSeconds)).onChange(async (v) => {
        const n = parseInt(v, 10);
        this.plugin.settings.pollSeconds = isNaN(n) ? 5 : Math.max(2, n);
        await this.plugin.saveSettings();
        this.plugin.startPolling();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Notify on each job").setDesc("Show a toast whenever a job runs.").addToggle(
      (t) => t.setValue(this.plugin.settings.notifyOnJob).onChange(async (v) => {
        this.plugin.settings.notifyOnJob = v;
        await this.plugin.saveSettings();
      })
    );
    containerEl.createEl("h3", { text: "Advanced: webhook paths" });
    for (const [key, label, desc] of [
      ["pollPath", "Poll path", "GET endpoint returning pending jobs."],
      ["resultPath", "Result path", "POST endpoint we send job results to."],
      ["sendPath", "Send path", "POST endpoint for the manual 'send note' push."]
    ]) {
      new import_obsidian.Setting(containerEl).setName(label).setDesc(desc).addText(
        (t) => t.setValue(this.plugin.settings[key]).onChange(async (v) => {
          this.plugin.settings[key] = v.trim();
          await this.plugin.saveSettings();
        })
      );
    }
    new import_obsidian.Setting(containerEl).setName("Test connection").addButton(
      (b) => b.setButtonText("Test now").setCta().onClick(() => this.plugin.testConnection())
    );
  }
};
function randomToken(len) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && cryptoObj.getRandomValues) {
    const buf = new Uint32Array(len);
    cryptoObj.getRandomValues(buf);
    for (let i = 0; i < len; i++)
      out += chars[buf[i] % chars.length];
  } else {
    for (let i = 0; i < len; i++)
      out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}
function errMsg(e) {
  if (e instanceof Error)
    return e.message;
  return String(e);
}
