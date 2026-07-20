import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
	normalizePath,
	requestUrl,
	Menu,
	MarkdownPostProcessorContext,
	setIcon,
} from "obsidian";

/* ------------------------------------------------------------------ */
/*  Settings                                                           */
/* ------------------------------------------------------------------ */

interface N8nBridgeSettings {
	baseUrl: string; // e.g. https://demos25.me
	pollPath: string; // webhook path that returns pending jobs
	resultPath: string; // webhook path we POST results to
	sendPath: string; // webhook path for the manual "send note" push
	device: string; // this device's name (unique per device)
	secret: string; // shared secret, gates every request
	pollSeconds: number; // how often to poll
	enablePolling: boolean; // master switch for the background loop
	notifyOnJob: boolean; // toast when a job runs
	malClientId: string;
	malClientSecret: string;
	malAccessToken: string;
	malRefreshToken: string;
	malTokenExpiresAt: number;
	malCodeVerifier: string;
	malOauthState: string;
	// MCP Server settings
	mcpEnabled: boolean;
	mcpPort: number;
	mcpName: string;
	// Whole-vault sync (our own server: vault-sync)
	syncUrl: string; // e.g. https://vaultsync.demos25.me
	syncSecret: string; // shared secret for the vault-sync server
	syncEnabled: boolean; // master switch for background vault sync
	syncSeconds: number; // how often to run a sync cycle
	syncState: Record<string, number>; // last-synced mtime per relative path
}

const DEFAULT_SETTINGS: N8nBridgeSettings = {
	baseUrl: "https://demos25.me",
	pollPath: "/webhook/obsidian-poll",
	resultPath: "/webhook/obsidian-result",
	sendPath: "/webhook/obsidian-send",
	device: "",
	secret: "",
	pollSeconds: 5,
	enablePolling: true,
	notifyOnJob: true,
	malClientId: "",
	malClientSecret: "",
	malAccessToken: "",
	malRefreshToken: "",
	malTokenExpiresAt: 0,
	malCodeVerifier: "",
	malOauthState: "",
	mcpEnabled: false,
	mcpPort: 3001,
	mcpName: "Obsidian Vault",
	syncUrl: "https://vaultsync.demos25.me",
	syncSecret: "",
	syncEnabled: false,
	syncSeconds: 30,
	syncState: {},
};

const MAL_REDIRECT_URI = "obsidian://n8n-bridge-mal";
const MAL_STATUS: Record<string, string> = {
	Watching: "watching",
	Watched: "completed",
	"Plan to Watch": "plan_to_watch",
	"On Hold / Continue": "on_hold",
};

/* ------------------------------------------------------------------ */
/*  Anime tracker types                                                */
/* ------------------------------------------------------------------ */

interface MalAnimeSearchResult {
	data: Array<{
		node: {
			id: number;
			title: string;
			main_picture?: { medium: string; large: string };
			alternative_titles?: { synonyms: string[]; en: string; ja: string };
			start_date: string;
			end_date: string;
			synopsis: string;
			mean: number;
			rank: number;
			popularity: number;
			num_episodes: number;
			status: string;
			genres: Array<{ id: number; name: string }>;
			num_list_users: number;
			num_scoring_users: number;
			nsfw: string;
			created_at: string;
			updated_at: string;
			media_type: string;
		};
	}>;
	paging?: { next: string };
}

interface MalAnimeDetails {
	id: number;
	title: string;
	main_picture?: { medium: string; large: string };
	alternative_titles?: { synonyms: string[]; en: string; ja: string };
	start_date: string;
	end_date: string;
	synopsis: string;
	mean: number;
	rank: number;
	popularity: number;
	num_episodes: number;
	status: string;
	genres: Array<{ id: number; name: string }>;
	num_list_users: number;
	num_scoring_users: number;
	nsfw: string;
	media_type: string;
}

interface MalListEntry {
	node: MalAnimeDetails;
	list_status: {
		status: string;
		score: number;
		num_episodes_watched: number;
		is_rewatching?: boolean;
		start_date?: string;
		finish_date?: string;
		updated_at?: string;
	};
}

interface MalListPage {
	data: MalListEntry[];
	paging?: { next?: string };
}

interface AnimeLibraryItem {
	file: TFile;
	malId: number;
	title: string;
	englishTitle: string;
	poster: string;
	status: string;
	malStatus: string;
	watched: number;
	episodes: number;
	userScore: number;
	malScore: number;
	mediaType: string;
	year: string;
	genres: string[];
}

/* ------------------------------------------------------------------ */
/*  Job shape (what n8n sends us)                                      */
/* ------------------------------------------------------------------ */

interface Job {
	id: string; // unique job id, echoed back in the result
	action:
		| "read_note"
		| "read_file"
		| "write_note"
		| "append_note"
		| "create_note"
		| "delete_note"
		| "delete_many"
		| "purge_folder"
		| "list_notes"
		| "search_vault"
		| "mal_token"
		| "sync_brain"
		| "ping";
	path?: string; // vault-relative path, for note ops
	content?: string; // payload for write/append/create; JSON facts for sync_brain
	query?: string; // for search_vault
	folder?: string; // optional scope for list_notes
}

interface JobResult {
	id: string;
	device: string;
	ok: boolean;
	action: string;
	path?: string;
	data?: unknown;
	error?: string;
}

/* ------------------------------------------------------------------ */
/*  Plugin                                                             */
/* ------------------------------------------------------------------ */

export default class N8nBridgePlugin extends Plugin {
	settings!: N8nBridgeSettings;
	private pollTimer: number | null = null;
	private watchdogTimer: number | null = null;
	private polling = false; // re-entrancy guard
	private pollStartedAt = 0; // when the in-flight cycle began (stuck detection)
	private lastPollActivity = 0; // when a cycle last completed (watchdog)
	private authWarned = false; // only toast "unauthorized" once per streak
	private statusEl: HTMLElement | null = null;
	private animeSearchCache: Map<string, MalAnimeSearchResult> = new Map();
	private syncTimer: number | null = null;
	private syncing = false; // re-entrancy guard for sync cycles

	async onload() {
		await this.loadSettings();

		// Auto-generate a device name + secret on first run so the user
		// has something to paste into n8n immediately.
		let dirty = false;
		if (!this.settings.device) {
			this.settings.device = "obsidian-" + randomToken(6);
			dirty = true;
		}
		if (!this.settings.secret) {
			this.settings.secret = randomToken(24);
			dirty = true;
		}
		if (dirty) await this.saveSettings();

		this.addSettingTab(new N8nBridgeSettingTab(this.app, this));

		this.registerMarkdownCodeBlockProcessor(
			"anime-tracker",
			(_source, el, ctx) => this.renderAnimeTracker(el, ctx)
		);
		this.registerMarkdownCodeBlockProcessor(
			"anime-library",
			(source, el) => this.renderAnimeLibrary(source, el)
		);
		this.registerObsidianProtocolHandler("n8n-bridge-mal", (params) =>
			this.finishMalAuthorization(params)
		);

		// Status-bar indicator (desktop; harmless no-op on mobile).
		this.statusEl = this.addStatusBarItem();
		this.setStatus("idle");

		// Command: manually push the active note to n8n.
		this.addCommand({
			id: "send-active-note-to-n8n",
			name: "Send current note to n8n",
			callback: () => this.sendActiveNote(),
		});

		// Command: poll once, right now.
		this.addCommand({
			id: "poll-n8n-now",
			name: "Check n8n for jobs now",
			callback: () => this.pollOnce(true),
		});

		// Command: send a connectivity ping to n8n.
		this.addCommand({
			id: "test-n8n-connection",
			name: "Test n8n connection",
			callback: () => this.testConnection(),
		});

		this.addCommand({
			id: "import-full-mal-library",
			name: "Import or refresh full MyAnimeList library",
			callback: () => this.importFullMalLibrary(),
		});

		this.addCommand({
			id: "sync-vault-to-mal",
			name: "Sync vault anime to MyAnimeList",
			callback: () => this.syncVaultToMal(),
		});

		// Command: run a whole-vault sync cycle right now.
		this.addCommand({
			id: "sync-vault-now",
			name: "Sync vault now",
			callback: () => this.syncVaultOnce(true),
		});

		// Right-click a note -> send to n8n.
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file) => {
				if (file instanceof TFile && file.extension === "md") {
					menu.addItem((i) =>
						i
							.setTitle("Send to n8n")
							.setIcon("workflow")
							.onClick(() => this.sendNoteFile(file))
					);
				}
			})
		);

		// Kick off the background poll loop once the workspace is ready.
		this.app.workspace.onLayoutReady(() => {
			this.startPolling();
			// Auto-start the local MCP server if the user left it enabled.
			if (this.settings.mcpEnabled) {
				this.startMcpServer().catch((e) =>
					console.error("MCP auto-start failed:", e)
				);
			}
			// Start the whole-vault sync loop if enabled.
			this.startVaultSync();
		});

		// ---- resume triggers: restart polling the instant the app wakes ----
		// Mobile OSes freeze timers when the app is backgrounded/screen-locked.
		// Each of these events fires on a different wake path; all funnel into
		// resumePolling(), which is cheap and idempotent.
		this.registerDomEvent(document, "visibilitychange", () => {
			if (!document.hidden) {
				this.resumePolling("visible");
				this.kickVaultSync();
			}
		});
		this.registerDomEvent(window, "focus", () => this.resumePolling("focus"));
		this.registerDomEvent(window, "online", () => this.resumePolling("online"));
		// Fires when the user switches notes/tabs — a strong "app is alive" signal
		// that also works on mobile where focus events can be unreliable.
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () =>
				this.resumePolling("leaf")
			)
		);

		// ---- watchdog: self-heal a silently dead loop ----
		// If timers were frozen or a cycle got stuck awaiting a dead socket,
		// no event may ever fire. Check every 15s that a cycle completed
		// recently; if not, force-restart the loop. registerInterval ties it
		// to the plugin lifecycle.
		this.watchdogTimer = this.registerInterval(
			window.setInterval(() => this.watchdogCheck(), 15_000)
		);
	}

	onunload() {
		this.stopPolling();
		this.stopVaultSync();
		// Tear down the MCP HTTP server so the port is released on reload.
		this.stopMcpServer().catch((e) =>
			console.error("MCP stop failed on unload:", e)
		);
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

	/* ---------------- anime tracker + MyAnimeList ---------------- */

	private async renderAnimeTracker(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
		if (!(file instanceof TFile)) return;
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		let watched = Math.max(0, Number(fm.watched) || 0);
		const episodes = Math.max(0, Number(fm.episodes) || 0);
		let status = String(fm.status || "Plan to Watch");
		const malId = Math.max(0, Number(fm.mal_id) || 0);
		const accent = String(fm.accent || "#7c5cff");
		const banner = String(fm.banner || "");
		const poster = String(fm.poster || "");
		const title = String(fm.english_title || fm.title || file.basename);
		const nativeTitle = String(fm.title || "");
		const malScore = Number(fm.mal_score) || 0;
		const genres: string[] = Array.isArray(fm.genres) ? fm.genres.map(String) : [];
		const year = String(fm.start_date || "").slice(0, 4);

		const root = el.createDiv({ cls: "anime-hero is-locked" });
		root.style.setProperty("--accent", accent);

		// ── Hero banner ─────────────────────────────────────────────
		const hero = root.createDiv({ cls: "anime-hero__banner" });
		if (banner) hero.createEl("img", { cls: "anime-hero__banner-img", attr: { src: banner, alt: "", loading: "lazy" } });
		hero.createDiv({ cls: "anime-hero__banner-shade" });

		if (malScore > 0) {
			const gem = hero.createDiv({ cls: "anime-hero__gem" });
			gem.createSpan({ cls: "anime-hero__gem-score", text: malScore.toFixed(1) });
			gem.createSpan({ cls: "anime-hero__gem-label", text: "MAL" });
		}

		// Edit lock: card is read-only until unlocked, so casual scrolling
		// can't nudge the slider or change status.
		// Pencil toggles the advanced tools (search / pull). The episode
		// tracker itself stays always-on — hiding it read as "missing".
		const lockBtn = hero.createEl("button", { cls: "anime-hero__lock", attr: { "aria-label": "More tools" } });
		setIcon(lockBtn, "pencil");
		lockBtn.addEventListener("click", () => {
			const locked = root.hasClass("is-locked");
			root.toggleClass("is-locked", !locked);
			setIcon(lockBtn, locked ? "check" : "pencil");
		});

		// ── Poster + titles ─────────────────────────────────────────
		const head = root.createDiv({ cls: "anime-hero__head" });
		const posterBox = head.createDiv({ cls: "anime-hero__poster" });
		if (poster) posterBox.createEl("img", { cls: "anime-hero__poster-img", attr: { src: poster, alt: title, loading: "lazy" } });
		const titles = head.createDiv({ cls: "anime-hero__titles" });
		titles.createEl("h2", { cls: "anime-hero__title", text: title });
		if (nativeTitle && nativeTitle !== title) titles.createDiv({ cls: "anime-hero__native", text: nativeTitle });
		const chips = titles.createDiv({ cls: "anime-hero__chips" });
		if (year) chips.createSpan({ cls: "anime-hero__chip", text: year });
		if (episodes) chips.createSpan({ cls: "anime-hero__chip", text: `${episodes} eps` });
		for (const g of genres.slice(0, 3)) chips.createSpan({ cls: "anime-hero__chip anime-hero__chip--genre", text: g });
		if (malId) titles.createEl("a", {
			cls: "anime-hero__mal", text: "MyAnimeList ↗",
			href: `https://myanimelist.net/anime/${malId}`,
			attr: { target: "_blank", rel: "noopener noreferrer" },
		});

		// ── Progress ────────────────────────────────────────────────
		const prog = root.createDiv({ cls: "anime-hero__progress" });
		const progTop = prog.createDiv({ cls: "anime-hero__progress-top" });
		const countEl = progTop.createDiv({ cls: "anime-hero__count" });
		const watchedEl = countEl.createSpan({ cls: "anime-hero__watched", text: String(watched) });
		countEl.createSpan({ cls: "anime-hero__total", text: ` / ${episodes || "?"} eps` });
		const sync = progTop.createDiv({ cls: "anime-hero__sync" });
		const setSync = (text: string, mode = "") => { sync.setText(text); sync.className = `anime-hero__sync ${mode}`.trim(); };
		setSync(this.settings.malAccessToken ? "MAL ✓" : "local", this.settings.malAccessToken ? "is-on" : "");

		const setPct = () => root.style.setProperty("--pct", episodes ? `${Math.min(100, Math.round((watched / episodes) * 100))}%` : "0%");
		setPct();

		const barWrap = prog.createDiv({ cls: "anime-hero__bar-wrap" });
		const minus = barWrap.createEl("button", { cls: "anime-hero__step", attr: { "aria-label": "Minus one episode" } });
		setIcon(minus, "minus");
		const range = barWrap.createEl("input", { cls: "anime-hero__range", type: "range", attr: { "aria-label": "Episodes watched" } });
		range.min = "0"; range.max = String(episodes || 999); range.step = "1"; range.value = String(watched);
		const plus = barWrap.createEl("button", { cls: "anime-hero__step", attr: { "aria-label": "Plus one episode" } });
		setIcon(plus, "plus");

		// ── Status pills ────────────────────────────────────────────
		const pills = root.createDiv({ cls: "anime-hero__pills" });
		const pillEls: HTMLElement[] = [];

		let busy = false;
		const persist = async (nextWatched: number, nextStatus: string) => {
			if (busy) return;
			busy = true;
			watched = Math.max(0, Math.min(nextWatched, episodes || 999));
			status = nextStatus;
			watchedEl.setText(String(watched));
			range.value = String(watched);
			setPct();
			pillEls.forEach((p) => p.toggleClass("is-active", p.getText() === status));
			setSync(this.settings.malAccessToken && malId ? "syncing…" : "saved");
			try {
				await this.app.fileManager.processFrontMatter(file, (f) => {
					f.watched = watched;
					f.status = status;
				});
				if (this.settings.malAccessToken && malId) {
					await this.updateMalList(malId, watched, status);
					setSync("MAL ✓", "is-on");
				} else {
					setSync(malId ? "saved" : "no MAL id");
				}
			} catch (error) {
				setSync("sync failed", "is-err");
				new Notice("Anime tracker: " + errMsg(error));
			} finally {
				busy = false;
			}
		};

		for (const label of Object.keys(MAL_STATUS)) {
			const pill = pills.createEl("button", { text: label, cls: "anime-hero__pill" });
			if (label === status) pill.addClass("is-active");
			pill.addEventListener("click", () => persist(watched, label));
			pillEls.push(pill);
		}

		range.addEventListener("change", () => persist(Number(range.value), status));
		minus.addEventListener("click", () => persist(watched - 1, status));
		plus.addEventListener("click", () => persist(watched + 1, status));

		// ── Search (edit mode only) ─────────────────────────────────
		const searchSection = root.createDiv({ cls: "anime-hero__search" });
		const searchInput = searchSection.createEl("input", {
			cls: "anime-hero__search-input", type: "search",
			placeholder: "Search MyAnimeList…",
			attr: { "aria-label": "Search anime" },
		});
		const searchResults = searchSection.createDiv({ cls: "anime-tracker__search-results" });
		let searchDebounce: number;
		searchInput.addEventListener("input", () => {
			clearTimeout(searchDebounce);
			const query = searchInput.value.trim();
			if (query.length < 2) { searchResults.empty(); searchResults.removeClass("has-results"); return; }
			searchDebounce = window.setTimeout(() => this.performAnimeSearch(query, searchResults, file, malId), 300);
		});

		// ── Footer: pull from MAL (edit mode only) ──────────────────
		if (this.settings.malAccessToken && malId) {
			const footer = root.createDiv({ cls: "anime-hero__footer" });
			const pull = footer.createEl("button", { text: "Pull from MyAnimeList", cls: "anime-hero__pull" });
			pull.addEventListener("click", async () => {
				try {
					setSync("loading…");
					const remote = await this.getMalListStatus(malId);
					if (!remote) throw new Error("This anime is not on your MAL list yet.");
					const localStatus = Object.keys(MAL_STATUS).find((k) => MAL_STATUS[k] === remote.status) ?? "Plan to Watch";
					await persist(remote.num_episodes_watched || 0, localStatus);
				} catch (error) {
					setSync("pull failed", "is-err");
					new Notice("MyAnimeList: " + errMsg(error));
				}
			});
		}
	}

	private async performAnimeSearch(query: string, resultsEl: HTMLElement, file: TFile, currentMalId: number) {
		resultsEl.empty();
		resultsEl.addClass("has-results");
		
		// Check cache first
		const cacheKey = query.toLowerCase();
		if (this.animeSearchCache.has(cacheKey)) {
			this.renderSearchResults(this.animeSearchCache.get(cacheKey)!, resultsEl, file, currentMalId);
			return;
		}

		const loading = resultsEl.createDiv({ cls: "anime-tracker__search-loading", text: "Searching…" });
		
		try {
			if (!this.settings.malAccessToken) {
				loading.setText("Connect MAL to search");
				return;
			}
			
			const token = await this.malAccessToken();
			const response = await requestUrl({
				url: `https://api.myanimelist.net/v2/anime?q=${encodeURIComponent(query)}&limit=10&fields=id,title,main_picture,alternative_titles,start_date,end_date,synopsis,mean,rank,popularity,num_episodes,status,genres,num_list_users,media_type`,
				method: "GET",
				headers: { Authorization: `Bearer ${token}` },
				throw: false,
			});
			
			loading.remove();
			
			if (response.status < 200 || response.status >= 300) {
				resultsEl.createDiv({ cls: "anime-tracker__search-error", text: "Search failed" });
				return;
			}
			
			const data: MalAnimeSearchResult = response.json;
			this.animeSearchCache.set(cacheKey, data);
			this.renderSearchResults(data, resultsEl, file, currentMalId);
		} catch (e) {
			loading.remove();
			resultsEl.createDiv({ cls: "anime-tracker__search-error", text: "Search error" });
		}
	}

	private renderSearchResults(data: MalAnimeSearchResult, resultsEl: HTMLElement, file: TFile, currentMalId: number) {
		if (!data.data?.length) {
			resultsEl.createDiv({ cls: "anime-tracker__search-empty", text: "No results found" });
			return;
		}

		const list = resultsEl.createDiv({ cls: "anime-tracker__results-list" });
		
		for (const item of data.data) {
			const anime = item.node;
			const result = list.createDiv({ cls: "anime-tracker__result-item" });
			
			if (anime.main_picture?.medium) {
				result.createEl("img", {
					cls: "anime-tracker__result-img",
					attr: { src: anime.main_picture.medium, alt: anime.title }
				});
			}
			
			const info = result.createDiv({ cls: "anime-tracker__result-info" });
			info.createDiv({ cls: "anime-tracker__result-title", text: anime.title });
			
			const meta = info.createDiv({ cls: "anime-tracker__result-meta" });
			if (anime.num_episodes > 0) meta.createSpan({ text: `${anime.num_episodes} eps` });
			if (anime.mean > 0) meta.createSpan({ text: `★ ${anime.mean.toFixed(1)}` });
			if (anime.status) meta.createSpan({ text: anime.status.replace(/_/g, " ") });
			
			if (anime.synopsis) {
				info.createDiv({ 
					cls: "anime-tracker__result-synopsis", 
					text: anime.synopsis.slice(0, 120) + "…" 
				});
			}

			const actions = result.createDiv({ cls: "anime-tracker__result-actions" });
			
			if (anime.id === currentMalId) {
				actions.createSpan({ cls: "anime-tracker__result-current", text: "Current" });
			} else {
				const btn = actions.createEl("button", { 
					cls: "anime-tracker__result-btn", 
					text: "Use this anime" 
				});
				btn.addEventListener("click", async () => {
					await this.app.fileManager.processFrontMatter(file, (fm) => {
						fm.mal_id = anime.id;
						fm.episodes = anime.num_episodes || 0;
						fm.watched = 0;
						fm.status = "Plan to Watch";
					});
					new Notice(`Set to "${anime.title}" (MAL ID: ${anime.id}). Reload note to see tracker.`);
				});
			}
		}
	}

	private async getMalAnimeDetails(malId: number): Promise<MalAnimeDetails | null> {
		if (!this.settings.malAccessToken) return null;
		try {
			const token = await this.malAccessToken();
			const response = await requestUrl({
				url: `https://api.myanimelist.net/v2/anime/${malId}?fields=id,title,main_picture,alternative_titles,start_date,end_date,synopsis,mean,rank,popularity,num_episodes,status,genres,num_list_users,num_scoring_users,nsfw,media_type`,
				method: "GET",
				headers: { Authorization: `Bearer ${token}` },
				throw: false,
			});
			if (response.status < 200 || response.status >= 300) return null;
			return response.json;
		} catch {
			return null;
		}
	}

	async startMalAuthorization() {
		if (!this.settings.malClientId) {
			new Notice("Enter your MyAnimeList Client ID first.");
			return;
		}
		this.settings.malCodeVerifier = randomToken(64);
		this.settings.malOauthState = randomToken(24);
		await this.saveSettings();
		const query = new URLSearchParams({
			response_type: "code",
			client_id: this.settings.malClientId,
			state: this.settings.malOauthState,
			redirect_uri: MAL_REDIRECT_URI,
			code_challenge: this.settings.malCodeVerifier,
			code_challenge_method: "plain",
		});
		window.open(`https://myanimelist.net/v1/oauth2/authorize?${query.toString()}`);
	}

	private async finishMalAuthorization(params: Record<string, string>) {
		if (!params.code || params.state !== this.settings.malOauthState) {
			new Notice("MyAnimeList connection failed: invalid OAuth response.");
			return;
		}
		try {
			const body = new URLSearchParams({
				client_id: this.settings.malClientId,
				client_secret: this.settings.malClientSecret,
				grant_type: "authorization_code",
				code: params.code,
				redirect_uri: MAL_REDIRECT_URI,
				code_verifier: this.settings.malCodeVerifier,
			});
			const response = await requestUrl({
				url: "https://myanimelist.net/v1/oauth2/token",
				method: "POST",
				contentType: "application/x-www-form-urlencoded",
				body: body.toString(),
				throw: false,
			});
			if (response.status < 200 || response.status >= 300) {
				throw new Error(`token exchange failed (HTTP ${response.status})`);
			}
			await this.storeMalTokens(response.json);
			new Notice("MyAnimeList connected. Reopen the anime note to refresh its tracker.");
		} catch (error) {
			new Notice("MyAnimeList connection failed: " + errMsg(error));
		}
	}

	private async storeMalTokens(tokens: any) {
		this.settings.malAccessToken = tokens.access_token;
		this.settings.malRefreshToken = tokens.refresh_token || this.settings.malRefreshToken;
		this.settings.malTokenExpiresAt = Date.now() + Math.max(60, tokens.expires_in || 3600) * 1000;
		this.settings.malCodeVerifier = "";
		this.settings.malOauthState = "";
		await this.saveSettings();
	}

	private async malAccessToken(): Promise<string> {
		if (!this.settings.malAccessToken) throw new Error("MyAnimeList is not connected.");
		if (Date.now() < this.settings.malTokenExpiresAt - 60_000) return this.settings.malAccessToken;
		if (!this.settings.malRefreshToken) throw new Error("MyAnimeList session expired. Reconnect it.");
		const body = new URLSearchParams({
			client_id: this.settings.malClientId,
			client_secret: this.settings.malClientSecret,
			grant_type: "refresh_token",
			refresh_token: this.settings.malRefreshToken,
		});
		const response = await requestUrl({
			url: "https://myanimelist.net/v1/oauth2/token",
			method: "POST",
			contentType: "application/x-www-form-urlencoded",
			body: body.toString(),
			throw: false,
		});
		if (response.status < 200 || response.status >= 300) throw new Error("MAL token refresh failed.");
		await this.storeMalTokens(response.json);
		return this.settings.malAccessToken;
	}

	private async updateMalList(malId: number, watched: number, status: string) {
		const token = await this.malAccessToken();
		const body = new URLSearchParams({
			status: MAL_STATUS[status] || "plan_to_watch",
			num_watched_episodes: String(watched),
		});
		const response = await requestUrl({
			url: `https://api.myanimelist.net/v2/anime/${malId}/my_list_status`,
			method: "PATCH",
			headers: { Authorization: `Bearer ${token}` },
			contentType: "application/x-www-form-urlencoded",
			body: body.toString(),
			throw: false,
		});
		if (response.status < 200 || response.status >= 300) {
			throw new Error(`MAL update failed (HTTP ${response.status}).`);
		}
	}

	private async getMalListStatus(malId: number): Promise<any | null> {
		const token = await this.malAccessToken();
		const response = await requestUrl({
			url: `https://api.myanimelist.net/v2/anime/${malId}?fields=my_list_status`,
			method: "GET",
			headers: { Authorization: `Bearer ${token}` },
			throw: false,
		});
		if (response.status < 200 || response.status >= 300) {
			throw new Error(`MAL read failed (HTTP ${response.status}).`);
		}
		return response.json?.my_list_status ?? null;
	}

	private async fetchFullMalList(): Promise<MalListEntry[]> {
		const token = await this.malAccessToken();
		const fields = [
			"id", "title", "main_picture", "alternative_titles",
			"start_date", "end_date", "synopsis", "mean", "rank",
			"popularity", "num_episodes", "status", "genres",
			"media_type", "my_list_status"
		].join(",");
		let url = `https://api.myanimelist.net/v2/users/@me/animelist?limit=100&sort=list_updated_at&fields=${fields}`;
		const entries: MalListEntry[] = [];
		while (url) {
			const response = await requestUrl({
				url,
				method: "GET",
				headers: { Authorization: `Bearer ${token}` },
				throw: false,
			});
			if (response.status < 200 || response.status >= 300) {
				throw new Error(`MAL list import failed (HTTP ${response.status}).`);
			}
			const page = response.json as MalListPage;
			entries.push(...(page.data || []));
			url = page.paging?.next || "";
		}
		return entries;
	}

	/** Hub note name for a local status — used for graph-view clustering. */
	private statusHubName(status: string): string {
		return status.includes("On Hold") ? "On Hold" : status;
	}

	/**
	 * Batch-fetch AniList banner image + dominant color for MAL ids.
	 * Chunks of 50 per request; failures degrade to empty (no banner/accent).
	 */
	private async fetchAniListMeta(ids: number[]): Promise<Record<number, { banner: string; color: string }>> {
		const out: Record<number, { banner: string; color: string }> = {};
		const query =
			"query($ids:[Int]){Page(perPage:50){media(idMal_in:$ids,type:ANIME){idMal bannerImage coverImage{color}}}}";
		for (let i = 0; i < ids.length; i += 50) {
			const chunk = ids.slice(i, i + 50);
			try {
				const resp = await requestUrl({
					url: "https://graphql.anilist.co",
					method: "POST",
					contentType: "application/json",
					body: JSON.stringify({ query, variables: { ids: chunk } }),
					throw: false,
				});
				const media = resp.json?.data?.Page?.media || [];
				for (const m of media) {
					if (m?.idMal) out[m.idMal] = { banner: m.bannerImage || "", color: m.coverImage?.color || "" };
				}
			} catch (e) {
				console.warn("AniList meta fetch failed for chunk", i, e);
			}
			// AniList rate limit is generous but be polite between chunks.
			if (i + 50 < ids.length) await new Promise((r) => window.setTimeout(r, 700));
		}
		return out;
	}

	async importFullMalLibrary() {
		if (!this.settings.malAccessToken) {
			new Notice("Connect MyAnimeList in n8n Bridge settings first.");
			return;
		}
		const notice = new Notice("Loading your full MyAnimeList library...", 0);
		try {
			const entries = await this.fetchFullMalList();
			await this.ensureVaultFolder("Anime Library");
			await this.ensureVaultFolder("Anime Library/Shows");
			await this.ensureVaultFolder("Anime Library/Hubs");
			notice.setMessage("Fetching banners & colors from AniList...");
			const meta = await this.fetchAniListMeta(entries.map((e) => e.node.id));
			let created = 0;
			let updated = 0;
			const genresSeen = new Set<string>();
			for (let index = 0; index < entries.length; index++) {
				const entry = entries[index];
				for (const g of entry.node.genres || []) genresSeen.add(g.name);
				const path = `Anime Library/Shows/${this.animeFileName(entry.node.title, entry.node.id)}.md`;
				const existing = this.app.vault.getAbstractFileByPath(path);
				const content = this.buildAnimeNote(
					entry,
					existing instanceof TFile ? await this.app.vault.read(existing) : "",
					meta[entry.node.id]
				);
				if (existing instanceof TFile) {
					await this.app.vault.modify(existing, content);
					updated++;
				} else {
					await this.app.vault.create(path, content);
					created++;
				}
				if ((index + 1) % 25 === 0) notice.setMessage(`Imported ${index + 1} of ${entries.length} anime...`);
			}
			// Hub notes: one per status + one per genre. Show notes link to
			// these, which makes the graph view cluster the library naturally.
			const hubs = ["Watching", "Watched", "Plan to Watch", "On Hold", "Dropped", ...genresSeen];
			for (const hub of hubs) {
				const hubPath = `Anime Library/Hubs/${hub.replace(/[\\/:*?"<>|]/g, "-")}.md`;
				if (!this.app.vault.getAbstractFileByPath(hubPath)) {
					await this.app.vault.create(hubPath, `---\ncssclasses:\n  - anime-hub\n---\n# ${hub}\n\nAll anime linked here appear in the graph view as one cluster.\n`);
				}
			}
			const dashboardPath = "Anime Library/Anime Library.md";
			const dashboard = [
				"---",
				"cssclasses:",
				"  - anime-library-page",
				"---",
				"# Anime Library",
				"",
				"```anime-library",
				"folder: Anime Library/Shows",
				"```",
				"",
			].join("\n");
			const dashboardFile = this.app.vault.getAbstractFileByPath(dashboardPath);
			if (dashboardFile instanceof TFile) await this.app.vault.modify(dashboardFile, dashboard);
			else await this.app.vault.create(dashboardPath, dashboard);
			new Notice(`MAL library ready: ${entries.length} anime (${created} new, ${updated} refreshed).`);
			await this.app.workspace.getLeaf(false).openFile(this.app.vault.getAbstractFileByPath(dashboardPath) as TFile);
		} catch (error) {
			new Notice("MAL library import failed: " + errMsg(error));
		} finally {
			notice.hide();
		}
	}

	async syncVaultToMal() {
		if (!this.settings.malAccessToken) {
			new Notice("Connect MyAnimeList in n8n Bridge settings first.");
			return;
		}
		const notice = new Notice("Scanning vault for anime notes...", 0);
		try {
			const files = this.app.vault.getMarkdownFiles();
			const animeFiles = files.filter((file) => {
				const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
				return fm.mal_id && fm.type === "anime";
			});

			if (!animeFiles.length) {
				new Notice("No anime notes with mal_id found in vault.");
				return;
			}

			notice.setMessage(`Found ${animeFiles.length} anime notes. Syncing to MAL...`);
			let synced = 0;
			let failed = 0;

			for (let i = 0; i < animeFiles.length; i++) {
				const file = animeFiles[i];
				const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
				const malId = Number(fm.mal_id);
				const watched = Math.max(0, Number(fm.watched) || 0);
				const status = String(fm.mal_status || fm.status || "plan_to_watch");
				const score = Math.max(0, Number(fm.user_score) || 0);

				// Map local status to MAL status
				const malStatus = MAL_STATUS[status] || "plan_to_watch";

				try {
					await this.updateMalList(malId, watched, status);
					synced++;
				} catch (e) {
					console.error(`Failed to sync ${file.path}:`, e);
					failed++;
				}

				if ((i + 1) % 10 === 0) {
					notice.setMessage(`Synced ${i + 1}/${animeFiles.length}...`);
				}
			}

			new Notice(`MAL sync complete: ${synced} updated, ${failed} failed.`);
		} catch (error) {
			new Notice("MAL sync failed: " + errMsg(error));
		} finally {
			notice.hide();
		}
	}

	private async ensureVaultFolder(path: string) {
		if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.createFolder(path);
	}

	private animeFileName(title: string, malId: number): string {
		const safe = title.replace(/[\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
		return `${safe || "Anime"} (${malId})`;
	}

	private yamlString(value: unknown): string {
		return JSON.stringify(String(value ?? ""));
	}

	private localAnimeStatus(status: string): string {
		return Object.keys(MAL_STATUS).find((label) => MAL_STATUS[label] === status)
			|| (status === "dropped" ? "Dropped" : status.replace(/_/g, " "));
	}

	private buildAnimeNote(entry: MalListEntry, existing: string, anilist?: { banner: string; color: string }): string {
		const anime = entry.node;
		const list = entry.list_status || (anime as any).my_list_status || {};
		const marker = "<!-- Your notes below this line are preserved during MAL refresh. -->";
		const personal = existing.includes(marker) ? existing.split(marker).slice(1).join(marker).trimStart() : "";
		const genres = (anime.genres || []).map((genre) => this.yamlString(genre.name)).join(", ");
		const englishTitle = anime.alternative_titles?.en || "";
		const localStatus = this.localAnimeStatus(list.status || "plan_to_watch");
		// Graph-view links: status hub + genre hubs. Kept in a footer section
		// so they organize the graph without cluttering the reading view.
		const hubLinks = [
			`[[${this.statusHubName(localStatus)}]]`,
			...(anime.genres || []).map((g) => `[[${g.name.replace(/[\\/:*?"<>|]/g, "-")}]]`),
		].join(" · ");
		const note = [
			"---",
			"type: anime",
			`mal_id: ${anime.id}`,
			`title: ${this.yamlString(anime.title)}`,
			`english_title: ${this.yamlString(englishTitle)}`,
			`poster: ${this.yamlString(anime.main_picture?.large || anime.main_picture?.medium || "")}`,
			`banner: ${this.yamlString(anilist?.banner || "")}`,
			`accent: ${this.yamlString(anilist?.color || "")}`,
			`mal_url: ${this.yamlString(`https://myanimelist.net/anime/${anime.id}`)}`,
			`status: ${this.yamlString(localStatus)}`,
			`mal_status: ${this.yamlString(list.status || "plan_to_watch")}`,
			`watched: ${Math.max(0, Number(list.num_episodes_watched) || 0)}`,
			`episodes: ${Math.max(0, Number(anime.num_episodes) || 0)}`,
			`user_score: ${Math.max(0, Number(list.score) || 0)}`,
			`mal_score: ${Math.max(0, Number(anime.mean) || 0)}`,
			`media_type: ${this.yamlString(anime.media_type || "")}`,
			`airing_status: ${this.yamlString(anime.status || "")}`,
			`start_date: ${this.yamlString(anime.start_date || "")}`,
			`end_date: ${this.yamlString(anime.end_date || "")}`,
			`genres: [${genres}]`,
			"cssclasses:",
			"  - anime-detail",
			"---",
			"",
			"```anime-tracker",
			"```",
			"",
			marker,
			personal || "\n## Notes\n",
			"",
			"---",
			`*Library:* ${hubLinks}`,
		].join("\n");
		return note.endsWith("\n") ? note : note + "\n";
	}

	private async renderAnimeLibrary(source: string, el: HTMLElement) {
		const folder = source.match(/^folder:\s*(.+)$/m)?.[1]?.trim() || "Anime Library/Shows";
		const files = this.app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(folder + "/"));
		const items: AnimeLibraryItem[] = files.map((file) => {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
			return {
				file, malId: Number(fm.mal_id) || 0, title: String(fm.title || file.basename),
				englishTitle: String(fm.english_title || ""), poster: String(fm.poster || ""),
				status: String(fm.status || "Plan to Watch"), malStatus: String(fm.mal_status || "plan_to_watch"),
				watched: Number(fm.watched) || 0, episodes: Number(fm.episodes) || 0,
				userScore: Number(fm.user_score) || 0, malScore: Number(fm.mal_score) || 0,
				mediaType: String(fm.media_type || ""), year: String(fm.start_date || "").slice(0, 4),
				genres: Array.isArray(fm.genres) ? fm.genres.map(String) : [],
			};
		}).filter((item) => item.malId > 0);

		const root = el.createDiv({ cls: "anime-library" });
		const toolbar = root.createDiv({ cls: "anime-library__toolbar" });
		const search = toolbar.createEl("input", { type: "search", cls: "anime-library__search", placeholder: "Search your anime..." });
		const select = toolbar.createEl("select", { cls: "anime-library__filter" });
		for (const status of ["All", "Watching", "Watched", "Plan to Watch", "On Hold / Continue", "Dropped"]) {
			select.createEl("option", { text: status, value: status });
		}
		const count = toolbar.createDiv({ cls: "anime-library__count" });
		const grid = root.createDiv({ cls: "anime-library__grid" });

		const render = () => {
			grid.empty();
			const query = search.value.trim().toLowerCase();
			const filtered = items.filter((item) => {
				const matchesText = !query || `${item.title} ${item.englishTitle} ${item.genres.join(" ")}`.toLowerCase().includes(query);
				return matchesText && (select.value === "All" || item.status === select.value);
			}).sort((a, b) => a.status.localeCompare(b.status) || b.userScore - a.userScore || a.title.localeCompare(b.title));
			count.setText(`${filtered.length} of ${items.length}`);
			for (const item of filtered) {
				const card = grid.createDiv({ cls: "anime-library__card" });
				card.tabIndex = 0;
				card.addEventListener("click", () => this.app.workspace.getLeaf(false).openFile(item.file));
				card.addEventListener("keydown", (event) => { if (event.key === "Enter") card.click(); });
				const media = card.createDiv({ cls: "anime-library__media" });
				if (item.poster) media.createEl("img", {
					cls: "anime-library__poster",
					attr: { src: item.poster, alt: item.englishTitle || item.title }
				});
				media.createDiv({ cls: "anime-library__status", text: item.status });
				const body = card.createDiv({ cls: "anime-library__body" });
				body.createDiv({ cls: "anime-library__title", text: item.englishTitle || item.title });
				const meta = body.createDiv({ cls: "anime-library__meta" });
				meta.createSpan({ text: item.episodes ? `${item.watched}/${item.episodes} eps` : `${item.watched} eps` });
				if (item.userScore) meta.createSpan({ text: `Your ${item.userScore}/10` });
				else if (item.malScore) meta.createSpan({ text: `MAL ${item.malScore.toFixed(1)}` });
				if (item.year) meta.createSpan({ text: item.year });
				const pct = item.episodes ? Math.min(100, Math.round(item.watched / item.episodes * 100)) : 0;
				const progress = body.createDiv({ cls: "anime-library__progress" });
				progress.createDiv({ cls: "anime-library__progress-value", attr: { style: `width:${pct}%` } });
			}
		};
		search.addEventListener("input", render);
		select.addEventListener("change", render);
		render();
	}

	/* ---------------- MCP Server ---------------- */

	private mcpServer: any = null;
	private mcpHttpServer: any = null;

	async toggleMcpServer(enabled: boolean) {
		if (enabled) {
			await this.startMcpServer();
		} else {
			await this.stopMcpServer();
		}
	}

	private async startMcpServer() {
		// Never stack two servers on the same port; stop any existing one first.
		await this.stopMcpServer();
		try {
			// Dynamic import to avoid bundling issues
			const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
			const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
			// Use require for Node builtins in Electron/Obsidian
			const http = window.require("http");

			this.mcpServer = new McpServer({
				name: this.settings.mcpName,
				version: "1.0.0",
			});

			// Tool: read_note
			this.mcpServer.tool(
				"read_note",
				"Read a note from the Obsidian vault",
				{ path: { type: "string", description: "Vault-relative path to the note (e.g. 'Notes/My Note.md')" } },
				async ({ path }: { path: string }) => {
					try {
						const file = this.app.vault.getAbstractFileByPath(path);
						if (!(file instanceof TFile)) throw new Error(`Note not found: ${path}`);
						const content = await this.app.vault.read(file);
						return { content: [{ type: "text", text: content }] };
					} catch (e) {
						return { content: [{ type: "text", text: `Error: ${errMsg(e)}` }], isError: true };
					}
				}
			);

			// Tool: write_note
			this.mcpServer.tool(
				"write_note",
				"Create or overwrite a note in the Obsidian vault",
				{
					path: { type: "string", description: "Vault-relative path" },
					content: { type: "string", description: "Note content" },
				},
				async ({ path, content }: { path: string; content: string }) => {
					try {
						const normalized = path.endsWith(".md") ? path : path + ".md";
						const file = this.app.vault.getAbstractFileByPath(normalized);
						if (file instanceof TFile) {
							await this.app.vault.modify(file, content);
						} else {
							await this.ensureFolder(normalized);
							await this.app.vault.create(normalized, content);
						}
						return { content: [{ type: "text", text: `Written: ${normalized}` }] };
					} catch (e) {
						return { content: [{ type: "text", text: `Error: ${errMsg(e)}` }], isError: true };
					}
				}
			);

			// Tool: append_note
			this.mcpServer.tool(
				"append_note",
				"Append content to an existing note",
				{
					path: { type: "string", description: "Vault-relative path" },
					content: { type: "string", description: "Content to append" },
				},
				async ({ path, content }: { path: string; content: string }) => {
					try {
						const normalized = path.endsWith(".md") ? path : path + ".md";
						const file = this.app.vault.getAbstractFileByPath(normalized);
						if (file instanceof TFile) {
							await this.app.vault.append(file, content.startsWith("\n") ? content : "\n" + content);
						} else {
							await this.ensureFolder(normalized);
							await this.app.vault.create(normalized, content);
						}
						return { content: [{ type: "text", text: `Appended to: ${normalized}` }] };
					} catch (e) {
						return { content: [{ type: "text", text: `Error: ${errMsg(e)}` }], isError: true };
					}
				}
			);

			// Tool: list_notes
			this.mcpServer.tool(
				"list_notes",
				"List notes in the vault, optionally filtered by folder",
				{ folder: { type: "string", description: "Optional folder path to filter by" } },
				async ({ folder }: { folder: string }) => {
					try {
						const files = this.app.vault.getMarkdownFiles();
						const filtered = folder
							? files.filter((f) => f.path.startsWith(folder))
							: files;
						const notes = filtered
							.slice(0, 200)
							.map((f) => ({ path: f.path, name: f.basename, mtime: f.stat.mtime }))
							.sort((a, b) => b.mtime - a.mtime);
						return { content: [{ type: "text", text: JSON.stringify(notes, null, 2) }] };
					} catch (e) {
						return { content: [{ type: "text", text: `Error: ${errMsg(e)}` }], isError: true };
					}
				}
			);

			// Tool: search_vault
			this.mcpServer.tool(
				"search_vault",
				"Search note contents in the vault",
				{ query: { type: "string", description: "Search query" } },
				async ({ query }: { query: string }) => {
					try {
						const files = this.app.vault.getMarkdownFiles();
						const hits: Array<{ path: string; excerpt: string }> = [];
						for (const f of files) {
							const text = await this.app.vault.cachedRead(f);
							const idx = text.toLowerCase().indexOf(query.toLowerCase());
							if (idx >= 0) {
								const start = Math.max(0, idx - 80);
								hits.push({ path: f.path, excerpt: text.slice(start, idx + query.length + 80).replace(/\s+/g, " ").trim() });
								if (hits.length >= 50) break;
							}
						}
						return { content: [{ type: "text", text: JSON.stringify(hits, null, 2) }] };
					} catch (e) {
						return { content: [{ type: "text", text: `Error: ${errMsg(e)}` }], isError: true };
					}
				}
			);

			// Create HTTP server
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
			});

			await this.mcpServer.connect(transport);

			this.mcpHttpServer = http.createServer(async (req: any, res: any) => {
				// CORS
				res.setHeader("Access-Control-Allow-Origin", "*");
				res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
				res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
				if (req.method === "OPTIONS") {
					res.writeHead(204);
					res.end();
					return;
				}
				await transport.handleRequest(req, res);
			});

			this.mcpHttpServer.listen(this.settings.mcpPort, () => {
				new Notice(`MCP Server running on http://localhost:${this.settings.mcpPort}/mcp`);
			});

			this.mcpHttpServer.on("error", (err: any) => {
				console.error("MCP Server error:", err);
				new Notice(`MCP Server error: ${err.message}`);
			});
		} catch (e) {
			new Notice(`Failed to start MCP Server: ${errMsg(e)}`);
			console.error("MCP Server start error:", e);
		}
	}

	private async stopMcpServer() {
		const wasRunning = this.mcpServer !== null || this.mcpHttpServer !== null;
		try {
			if (this.mcpServer) {
				await this.mcpServer.close();
				this.mcpServer = null;
			}
			if (this.mcpHttpServer) {
				this.mcpHttpServer.close();
				this.mcpHttpServer = null;
			}
			if (wasRunning) new Notice("MCP Server stopped");
		} catch (e) {
			new Notice(`Error stopping MCP Server: ${errMsg(e)}`);
		}
	}

	/* ---------------- poll loop ---------------- */

	startPolling() {
		this.stopPolling();
		if (!this.settings.enablePolling) {
			this.setStatus("paused");
			return;
		}
		const ms = Math.max(2, this.settings.pollSeconds) * 1000;
		// Short-poll with setInterval: each request is quick and self-contained,
		// so a backgrounded/suspended app (esp. mobile) can never get stuck
		// awaiting a held-open socket. Obsidian clears the interval on unload.
		this.pollTimer = this.registerInterval(
			window.setInterval(() => this.pollOnce(false), ms)
		);
		this.setStatus("idle");
		this.lastPollActivity = Date.now();
		// Immediate first poll so there's no initial delay.
		this.pollOnce(false);
	}

	stopPolling() {
		if (this.pollTimer !== null) {
			window.clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	/**
	 * Cheap, idempotent "make sure we're alive" — safe to call on every
	 * wake/focus/visibility event. Restarts the interval if it's gone and
	 * fires an immediate catch-up poll so queued jobs drain right away
	 * instead of waiting out the interval.
	 */
	resumePolling(reason: string) {
		if (!this.settings.enablePolling) return;
		if (this.pollTimer === null) {
			console.log(`n8n Bridge: resuming polling (${reason})`);
			this.startPolling();
			return;
		}
		// Interval exists — still fire a catch-up poll if we've been quiet
		// longer than one interval (frozen timers don't tick while asleep).
		const quietMs = Date.now() - this.lastPollActivity;
		if (quietMs > Math.max(2, this.settings.pollSeconds) * 1000) {
			this.pollOnce(false);
		}
	}

	/**
	 * Watchdog: if no poll cycle has completed in 3× the interval (min 45s),
	 * the loop is dead or stuck — rebuild it from scratch. Also breaks a
	 * cycle stuck >60s on a dead socket by clearing the re-entrancy guard.
	 */
	private watchdogCheck() {
		if (!this.settings.enablePolling) return;
		const now = Date.now();
		if (this.polling && this.pollStartedAt && now - this.pollStartedAt > 60_000) {
			console.warn("n8n Bridge: poll cycle stuck >60s — force-clearing");
			this.polling = false;
		}
		const staleMs = Math.max(45_000, this.settings.pollSeconds * 3000);
		if (now - this.lastPollActivity > staleMs) {
			console.warn("n8n Bridge: poll loop stale — watchdog restart");
			this.startPolling();
		}
	}

	private setStatus(state: "idle" | "busy" | "paused" | "error") {
		if (!this.statusEl) return;
		const map = {
			idle: "n8n ✓",
			busy: "n8n …",
			paused: "n8n ⏸",
			error: "n8n ⚠",
		};
		this.statusEl.setText(map[state]);
	}

	/**
	 * One poll cycle: ask n8n for pending jobs for this device, run each,
	 * and post the result back. `manual` controls whether we toast "no jobs".
	 */
	async pollOnce(manual: boolean) {
		if (this.polling) return; // don't overlap cycles
		if (!this.settings.enablePolling && !manual) return;
		if (!this.configOk()) {
			if (manual) new Notice("n8n Bridge: fill in base URL, device and secret first.");
			return;
		}
		this.polling = true;
		this.pollStartedAt = Date.now();
		try {
			const url =
				this.trimBase() +
				this.settings.pollPath +
				`?device=${encodeURIComponent(this.settings.device)}` +
				`&secret=${encodeURIComponent(this.settings.secret)}`;
			const resp = await requestUrl({
				url,
				method: "GET",
				throw: false,
			});
			if (resp.status < 200 || resp.status >= 300) {
				this.setStatus("error");
				if (manual)
					new Notice(`n8n Bridge: poll failed (HTTP ${resp.status}).`);
				return;
			}
			// Server can reply 200 with {ok:false, error:"unauthorized"} when the
			// secret/device doesn't match. That's NOT "no jobs" — surface it loudly
			// or the bridge dies silently while looking healthy.
			const body = resp.json as any;
			if (body && body.ok === false) {
				this.setStatus("error");
				if (!this.authWarned || manual) {
					this.authWarned = true;
					new Notice(
						`n8n Bridge: server rejected poll (${body.error || "ok:false"}) — check Secret and Device in settings.`,
						10000
					);
				}
				return;
			}
			this.authWarned = false;
			const jobs = this.parseJobs(resp.json);
			if (!jobs.length) {
				this.setStatus("idle");
				if (manual) new Notice("n8n Bridge: no pending jobs.");
				return;
			}
			this.setStatus("busy");
			for (const job of jobs) {
				const result = await this.runJob(job);
				await this.postResult(result);
				if (this.settings.notifyOnJob) {
					new Notice(
						`n8n: ${job.action}${
							job.path ? " " + job.path : ""
						} → ${result.ok ? "ok" : "error"}`
					);
				}
			}
			this.setStatus("idle");
		} catch (e) {
			this.setStatus("error");
			if (manual) new Notice("n8n Bridge: poll error — " + errMsg(e));
			console.error("n8n Bridge poll error", e);
		} finally {
			this.polling = false;
			this.lastPollActivity = Date.now();
		}
	}

	private parseJobs(body: unknown): Job[] {
		if (!body) return [];
		// n8n may return {jobs:[...]}, a bare array, or a single job object.
		const raw = (body as any).jobs ?? body;
		if (Array.isArray(raw)) return raw.filter((j) => j && j.action);
		if (raw && (raw as any).action) return [raw as Job];
		return [];
	}

	/* ---------------- job executor ---------------- */

	async runJob(job: Job): Promise<JobResult> {
		const base: JobResult = {
			id: job.id,
			device: this.settings.device,
			ok: false,
			action: job.action,
			path: job.path,
		};
		try {
			switch (job.action) {
				case "ping":
					return { ...base, ok: true, data: { pong: true, vault: this.app.vault.getName() } };

				case "mal_token": {
					// Returns a valid MAL access token, refreshing it if needed via
					// the plugin's own refresh flow. Gated by the bridge secret like
					// every other action; lets the remote agent write to MAL without
					// tokens ever being stored off-device.
					const token = await this.malAccessToken();
					return {
						...base,
						ok: true,
						data: {
							access_token: token,
							client_id: this.settings.malClientId,
							expires_at: this.settings.malTokenExpiresAt,
						},
					};
				}

				case "read_file": {
					// Adapter-level read: reaches any file in the vault folder,
					// including .obsidian configs — unlike read_note, which only
					// resolves indexed .md notes.
					const p = normalizePath(job.path || "");
					if (!p) throw new Error("read_file: path required");
					if (!(await this.app.vault.adapter.exists(p)))
						throw new Error("file not found: " + p);
					const content = await this.app.vault.adapter.read(p);
					return { ...base, ok: true, data: { content, path: p } };
				}

				case "read_note": {
					const file = this.requireFile(job.path);
					const content = await this.app.vault.read(file);
					return { ...base, ok: true, data: { content, path: file.path } };
				}

				case "write_note": {
					const path = this.requirePath(job.path);
					const content = job.content ?? "";
					const file = this.app.vault.getAbstractFileByPath(path);
					if (file instanceof TFile) {
						await this.app.vault.modify(file, content);
					} else {
						await this.ensureFolder(path);
						await this.app.vault.create(path, content);
					}
					return { ...base, ok: true, data: { written: content.length, path } };
				}

				case "append_note": {
					const path = this.requirePath(job.path);
					const add = job.content ?? "";
					const file = this.app.vault.getAbstractFileByPath(path);
					if (file instanceof TFile) {
						await this.app.vault.append(file, add.startsWith("\n") ? add : "\n" + add);
					} else {
						await this.ensureFolder(path);
						await this.app.vault.create(path, add);
					}
					return { ...base, ok: true, data: { appended: add.length, path } };
				}

case "create_note": {
				let path = this.requirePath(job.path);
				// don't clobber: if it exists, suffix a counter
				path = await this.uniquePath(path);
				await this.ensureFolder(path);
				await this.app.vault.create(path, job.content ?? "");
				return { ...base, ok: true, path, data: { path } };
			}

			case "delete_note": {
				const path = this.requirePath(job.path);
				const file = this.app.vault.getAbstractFileByPath(path);
				if (file instanceof TFile) {
					await this.app.vault.trash(file, true);
					return { ...base, ok: true, data: { deleted: true, path } };
				} else {
					throw new Error("note not found: " + path);
				}
			}

			case "delete_many": {
				const paths: string[] = job.path ? [job.path] : (job.query ? JSON.parse(job.query) : []);
				if (!paths.length) throw new Error("delete_many: provide 'path' (single) or 'query' (JSON array of paths)");
				let deleted = 0;
				const errors: string[] = [];
				for (const p of paths) {
					try {
						const norm = this.requirePath(p);
						const file = this.app.vault.getAbstractFileByPath(norm);
						if (file instanceof TFile) {
							await this.app.vault.trash(file, true);
							deleted++;
						} else {
							errors.push(norm + ": not found");
						}
					} catch (e) {
						errors.push(p + ": " + errMsg(e));
					}
				}
				return { ...base, ok: true, data: { deleted, errors: errors.length ? errors : undefined } };
			}

			case "purge_folder": {
				const folder = job.path ? this.requirePath(job.path).replace(/\.md$/, "") : (job.query || "");
				if (!folder) throw new Error("purge_folder: provide 'path' (folder path) or 'query' (folder path)");
				const files = this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(normalizePath(folder) + "/"));
				if (!files.length) return { ...base, ok: true, data: { deleted: 0, message: "no files in folder" } };
				let deleted = 0;
				for (const f of files) {
					await this.app.vault.trash(f, true);
					deleted++;
				}
				return { ...base, ok: true, data: { deleted, folder } };
			}

			case "list_notes": {
					const files = this.app.vault.getMarkdownFiles();
					const scope = job.folder ? normalizePath(job.folder) : "";
					const list = files
						.filter((f) => (scope ? f.path.startsWith(scope) : true))
						.map((f) => ({ path: f.path, name: f.basename, mtime: f.stat.mtime }))
						.sort((a, b) => b.mtime - a.mtime);
					return { ...base, ok: true, data: { count: list.length, notes: list.slice(0, 500) } };
				}

				case "search_vault": {
					const q = (job.query ?? "").toLowerCase();
					if (!q) throw new Error("search_vault requires a query");
					const files = this.app.vault.getMarkdownFiles();
					const hits: Array<{ path: string; excerpt: string }> = [];
					for (const f of files) {
						const text = await this.app.vault.cachedRead(f);
						const idx = text.toLowerCase().indexOf(q);
						if (idx >= 0) {
							const start = Math.max(0, idx - 60);
							hits.push({
								path: f.path,
								excerpt: text.slice(start, idx + q.length + 60).replace(/\s+/g, " ").trim(),
							});
							if (hits.length >= 50) break;
						}
					}
					return { ...base, ok: true, data: { count: hits.length, hits } };
				}

				case "sync_brain": {
					// One-shot brain sync done entirely in-plugin so the whole
					// operation is a SINGLE bridge round-trip (the old n8n version
					// made 8+ blocking calls per device and the task runner killed
					// it). Input: job.content = JSON { facts: {k:v}, stamp }.
					// Output: { edits: {k:v} } — fact lines the user changed in any
					// section note, for n8n to push back into the table.
					const payload = JSON.parse(job.content || "{}");
					const facts: Record<string, string> = payload.facts || {};
					const stamp: string = payload.stamp || new Date().toISOString();
					const DIR = "Brain";
					const SECTIONS = ["Identity", "People", "Education", "Preferences", "Projects", "Misc"];
					const sectionOf = (key: string): string => {
						const k = key.toLowerCase();
						if (/contact|phone|friend|family|father|mother|brother|sister|colleague/.test(k)) return "People";
						if (/university|course|lecture|study|group|exam|college|school|major|grade|semester/.test(k)) return "Education";
						if (/prefer|language|communication|view|style|like|dislike|favorite/.test(k)) return "Preferences";
						if (/project|goal|plan|work|business|idea|app|bot|agent/.test(k)) return "Projects";
						if (/^user_|^name$|^age$|^city$|birthday|identity|account|email/.test(k)) return "Identity";
						return "Misc";
					};

					// 1) reverse sync: read existing section notes, collect edits
					const edits: Record<string, string> = {};
					for (const s of SECTIONS) {
						const p = normalizePath(`${DIR}/${s}.md`);
						const f = this.app.vault.getAbstractFileByPath(p);
						if (!(f instanceof TFile)) continue;
						const content = await this.app.vault.read(f);
						for (const line of content.split("\n")) {
							const m = line.match(/^- \*\*([a-zA-Z0-9_]+)\*\*: (.*)$/);
							if (!m) continue;
							const k = m[1], v = m[2].trim();
							if (facts[k] !== v) { edits[k] = v; facts[k] = v; }
						}
					}

					// 2) bucket facts into sections (sorted)
					const buckets: Record<string, string[]> = {};
					for (const s of SECTIONS) buckets[s] = [];
					for (const k of Object.keys(facts).sort()) buckets[sectionOf(k)].push(k);

					// 3) write each section note + index
					const writeNote = async (path: string, content: string) => {
						const norm = normalizePath(path);
						const existing = this.app.vault.getAbstractFileByPath(norm);
						if (existing instanceof TFile) await this.app.vault.modify(existing, content);
						else { await this.ensureFolder(norm); await this.app.vault.create(norm, content); }
					};
					// Per-lobe presentation (emoji + one-line description). Purely
					// cosmetic — the fact lines below stay `- **key**: value` so the
					// reverse-sync parser above keeps working untouched.
					const META: Record<string, { icon: string; blurb: string }> = {
						Identity: { icon: "🪪", blurb: "Who the user is — the core facts." },
						People: { icon: "👥", blurb: "Contacts, family, friends and their numbers." },
						Education: { icon: "🎓", blurb: "Studies, courses, and university details." },
						Preferences: { icon: "⚙️", blurb: "How the user likes to work and communicate." },
						Projects: { icon: "🚀", blurb: "Personal goals, plans, and things in motion." },
						Misc: { icon: "🧩", blurb: "Everything else worth remembering." },
					};
					const sectionNote = (s: string): string => {
						const m = META[s] || { icon: "🧠", blurb: "" };
						const siblings = SECTIONS.filter((x) => x !== s).map((x) => `${(META[x] || { icon: "" }).icon} [[${x}]]`).join(" · ");
						const lines = ["---", "cssclasses:", "  - agent-brain", "---", `# ${m.icon} ${s}`, ""];
						if (m.blurb) lines.push(`> [!info] ${m.blurb}`, "");
						lines.push(`**Up:** [[Brain Index]]  ·  **Lobes:** ${siblings}`, "");
						lines.push(`## Facts · ${buckets[s].length}`);
						if (!buckets[s].length) lines.push("*Empty — facts will appear here as the agent learns.*");
						for (const k of buckets[s]) lines.push(`- **${k}**: ${facts[k]}`);
						lines.push("", "---", `> [!quote]- How this works`, `> This note is auto-managed by the agent's memory. **Edit any fact line and it updates the agent** on the next sync. Keep the \`- **key**: value\` shape.`, "", `*Last sync: ${stamp}*`);
						return lines.join("\n") + "\n";
					};
					for (const s of SECTIONS) await writeNote(`${DIR}/${s}.md`, sectionNote(s));

					const totalFacts = Object.keys(facts).length;
					const idx = ["---", "cssclasses:", "  - agent-brain", "  - dashboard", "---", "# 🧠 Brain Index", "",
						"> [!abstract] The agent's memory", `> ${totalFacts} facts across ${SECTIONS.length} lobes. Each lobe is a note; **edit any fact line to update the agent.**`, "",
						"**Up:** [[Home]]  ·  **Sibling maps:** [[Projects Index]] · [[Systems Database]]", "",
						"## 🧩 Lobes"];
					for (const s of SECTIONS) {
						const m = META[s] || { icon: "🧠", blurb: "" };
						idx.push(`- ${m.icon} [[${s}]] — **${buckets[s].length}** ${buckets[s].length === 1 ? "fact" : "facts"}${m.blurb ? " · " + m.blurb : ""}`);
					}
					idx.push("", `*Last sync: ${stamp}*`);
					await writeNote(`${DIR}/Brain Index.md`, idx.join("\n") + "\n");

					// 4) retire the old single-file brain
					const old = this.app.vault.getAbstractFileByPath(normalizePath(`${DIR}/Agent Brain.md`));
					if (old instanceof TFile) await this.app.vault.trash(old, true);

					return { ...base, ok: true, data: { edits, sections: SECTIONS.length, facts: Object.keys(facts).length } };
				}

				default:
					throw new Error("unknown action: " + (job as any).action);
			}
		} catch (e) {
			return { ...base, ok: false, error: errMsg(e) };
		}
	}

	/* ---------------- result push ---------------- */

	async postResult(result: JobResult) {
		// Backend (obsidian-result webhook) authenticates on body.secret and
		// stores body.result / body.ok / body.id. Pack data|error into `result`.
		const payload = {
			id: result.id,
			device: result.device,
			secret: this.settings.secret,
			ok: result.ok,
			action: result.action,
			path: result.path ?? "",
			result:
				result.ok
					? typeof result.data === "string"
						? result.data
						: JSON.stringify(result.data ?? "")
					: result.error ?? "error",
		};
		// Retry the result POST: the job is already marked "taken" server-side,
		// so if this fails the waiter times out even though the work was done.
		// 3 attempts with short backoff rides out flaky mobile networks.
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				const resp = await requestUrl({
					url: this.trimBase() + this.settings.resultPath,
					method: "POST",
					contentType: "application/json",
					headers: { "x-bridge-secret": this.settings.secret },
					body: JSON.stringify(payload),
					throw: false,
				});
				if (resp.status >= 200 && resp.status < 300) return;
				console.warn(`n8n Bridge: result POST HTTP ${resp.status} (attempt ${attempt}/3)`);
			} catch (e) {
				console.warn(`n8n Bridge: result POST failed (attempt ${attempt}/3)`, e);
			}
			if (attempt < 3) await new Promise((r) => window.setTimeout(r, 1000 * attempt));
		}
		console.error("n8n Bridge: giving up posting result for job", payload.id);
	}

	/* ---------------- manual push ---------------- */

	async sendActiveNote() {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== "md") {
			new Notice("n8n Bridge: no active markdown note.");
			return;
		}
		await this.sendNoteFile(file);
	}

	async sendNoteFile(file: TFile) {
		if (!this.configOk()) {
			new Notice("n8n Bridge: configure base URL, device and secret first.");
			return;
		}
		try {
			const content = await this.app.vault.read(file);
			const resp = await requestUrl({
				url: this.trimBase() + this.settings.sendPath,
				method: "POST",
				contentType: "application/json",
				headers: { "x-bridge-secret": this.settings.secret },
				body: JSON.stringify({
					device: this.settings.device,
					path: file.path,
					name: file.basename,
					content,
				}),
				throw: false,
			});
			if (resp.status >= 200 && resp.status < 300) {
				new Notice(`n8n Bridge: sent "${file.basename}".`);
			} else {
				new Notice(`n8n Bridge: send failed (HTTP ${resp.status}).`);
			}
		} catch (e) {
			new Notice("n8n Bridge: send error — " + errMsg(e));
		}
	}

	async testConnection() {
		if (!this.configOk()) {
			new Notice("n8n Bridge: fill in base URL, device and secret first.");
			return;
		}
		const url =
			this.trimBase() +
			this.settings.pollPath +
			`?device=${encodeURIComponent(this.settings.device)}` +
			`&secret=${encodeURIComponent(this.settings.secret)}&ping=1`;
		try {
			const resp = await requestUrl({ url, method: "GET", throw: false });
			if (resp.status >= 200 && resp.status < 300) {
				new Notice("n8n Bridge: connection OK ✓");
				this.setStatus("idle");
			} else {
				new Notice(`n8n Bridge: HTTP ${resp.status} from n8n.`);
				this.setStatus("error");
			}
		} catch (e) {
			new Notice("n8n Bridge: cannot reach n8n — " + errMsg(e));
			this.setStatus("error");
		}
	}

	/* ---------------- helpers ---------------- */

	private configOk(): boolean {
		return !!(this.settings.baseUrl && this.settings.device && this.settings.secret);
	}

	trimBase(): string {
		return this.settings.baseUrl.replace(/\/+$/, "");
	}

	private requireFile(path?: string): TFile {
		const p = this.requirePath(path);
		const f = this.app.vault.getAbstractFileByPath(p);
		if (!(f instanceof TFile)) throw new Error("note not found: " + p);
		return f;
	}

	private requirePath(path?: string): string {
		if (!path) throw new Error("path is required");
		let p = normalizePath(path);
		if (!p.endsWith(".md")) p += ".md";
		return p;
	}

	private async uniquePath(path: string): Promise<string> {
		if (!this.app.vault.getAbstractFileByPath(path)) return path;
		const dot = path.lastIndexOf(".");
		const stem = path.slice(0, dot);
		const ext = path.slice(dot);
		let i = 1;
		while (this.app.vault.getAbstractFileByPath(`${stem} ${i}${ext}`)) i++;
		return `${stem} ${i}${ext}`;
	}

	private async ensureFolder(filePath: string) {
		const slash = filePath.lastIndexOf("/");
		if (slash <= 0) return;
		const dir = filePath.slice(0, slash);
		if (!this.app.vault.getAbstractFileByPath(dir)) {
			await this.app.vault.createFolder(dir).catch(() => {
				/* folder may have been created concurrently */
			});
		}
	}

	/* ---------------- whole-vault sync (our own vault-sync server) ---------------- */
	// Two-way, newest-wins-by-mtime sync of the ENTIRE vault (markdown +
	// attachments/binaries) against our own server at settings.syncUrl.
	// No third-party plugin: every byte of this is ours.

	syncConfigOk(): boolean {
		return !!(this.settings.syncUrl && this.settings.syncSecret);
	}

	private trimSyncBase(): string {
		return this.settings.syncUrl.replace(/\/+$/, "");
	}

	startVaultSync() {
		this.stopVaultSync();
		if (!this.settings.syncEnabled) return;
		if (!this.syncConfigOk()) return;
		const ms = Math.max(10, this.settings.syncSeconds || 30) * 1000;
		// registerInterval ties the timer to the plugin lifecycle so it can't leak.
		this.syncTimer = this.registerInterval(
			window.setInterval(() => this.syncVaultOnce(false), ms)
		);
		// Run one cycle right away so the user doesn't wait a full interval.
		this.syncVaultOnce(false);
	}

	stopVaultSync() {
		if (this.syncTimer !== null) {
			window.clearInterval(this.syncTimer);
			this.syncTimer = null;
		}
	}

	// Cheap idempotent nudge used by resume triggers (app wake on mobile).
	kickVaultSync() {
		if (!this.settings.syncEnabled || !this.syncConfigOk()) return;
		this.syncVaultOnce(false);
	}

	private async syncFetch(
		path: string,
		init: { method?: string; body?: string; binary?: boolean } = {}
	): Promise<{ status: number; text: string; arrayBuffer: ArrayBuffer }> {
		const resp = await requestUrl({
			url: this.trimSyncBase() + path,
			method: init.method ?? "GET",
			headers: {
				"x-bridge-secret": this.settings.syncSecret,
				...(init.body ? { "content-type": "application/json" } : {}),
			},
			body: init.body,
			throw: false,
		});
		return {
			status: resp.status,
			text: resp.text ?? "",
			arrayBuffer: resp.arrayBuffer,
		};
	}

	// Enumerate every real file in the vault (skips folders and the plugin's
	// own config). Returns relative path -> mtime (ms).
	private async listLocalFiles(): Promise<Map<string, { mtime: number; size: number }>> {
		const out = new Map<string, { mtime: number; size: number }>();
		const files = this.app.vault.getFiles(); // all TFiles: md + binary attachments
		for (const f of files) {
			// Never sync the plugin's own data/config folder.
			if (f.path.startsWith(this.app.vault.configDir + "/")) continue;
			out.set(f.path, { mtime: f.stat.mtime, size: f.stat.size });
		}
		return out;
	}

	async syncVaultOnce(manual: boolean): Promise<void> {
		if (this.syncing) {
			if (manual) new Notice("n8n Bridge: sync already in progress.");
			return;
		}
		if (!this.syncConfigOk()) {
			if (manual) new Notice("n8n Bridge: set sync URL and secret first.");
			return;
		}
		this.syncing = true;
		const notice = manual ? new Notice("Syncing vault…", 0) : null;
		let pushed = 0,
			pulled = 0,
			deletedLocal = 0,
			deletedRemote = 0;
		try {
			// 1. Pull the remote manifest.
			const mres = await this.syncFetch("/sync/manifest");
			if (mres.status === 401) {
				if (manual) new Notice("n8n Bridge: sync unauthorized (bad secret).");
				return;
			}
			if (mres.status < 200 || mres.status >= 300) {
				if (manual) new Notice(`n8n Bridge: sync manifest HTTP ${mres.status}.`);
				return;
			}
			const remoteList: Array<{ path: string; mtime: number; deleted?: boolean }> =
				JSON.parse(mres.text).files ?? [];
			const remote = new Map<string, { mtime: number; deleted: boolean }>();
			for (const r of remoteList)
				remote.set(r.path, { mtime: r.mtime, deleted: !!r.deleted });

			const local = await this.listLocalFiles();
			const state = this.settings.syncState || {};
			const paths = new Set<string>([...local.keys(), ...remote.keys()]);

			for (const path of paths) {
				const l = local.get(path);
				const r = remote.get(path);
				const known = state[path] ?? 0;

				// --- exists locally, exists (live) remotely: newest wins ---
				if (l && r && !r.deleted) {
					if (l.mtime > r.mtime + 1) {
						await this.pushFile(path, l.mtime);
						pushed++;
					} else if (r.mtime > l.mtime + 1) {
						await this.pullFile(path, r.mtime);
						pulled++;
					}
					state[path] = Math.max(l.mtime, r.mtime);
					continue;
				}

				// --- only local ---
				if (l && !r) {
					await this.pushFile(path, l.mtime);
					pushed++;
					state[path] = l.mtime;
					continue;
				}

				// --- local + remote tombstone: did WE change it after the delete? ---
				if (l && r && r.deleted) {
					if (l.mtime > r.mtime + 1) {
						// local edit is newer than the delete -> resurrect remotely
						await this.pushFile(path, l.mtime);
						pushed++;
						state[path] = l.mtime;
					} else {
						// remote delete wins -> remove locally
						await this.deleteLocal(path);
						deletedLocal++;
						delete state[path];
					}
					continue;
				}

				// --- only remote ---
				if (!l && r) {
					if (r.deleted) {
						// tombstone for a file we don't have: nothing to do.
						delete state[path];
						continue;
					}
					if (known && known >= r.mtime) {
						// We had it, it's gone locally now, remote unchanged since ->
						// user deleted it here -> propagate the delete to the server.
						await this.pushDelete(path);
						deletedRemote++;
						delete state[path];
					} else {
						// New remote file -> pull it down.
						await this.pullFile(path, r.mtime);
						pulled++;
						state[path] = r.mtime;
					}
					continue;
				}
			}

			this.settings.syncState = state;
			await this.saveSettings();
			if (notice)
				notice.setMessage(
					`Sync done: ↑${pushed} ↓${pulled} ⌫local ${deletedLocal} ⌫remote ${deletedRemote}`
				);
		} catch (e) {
			console.error("n8n Bridge: vault sync failed", e);
			if (manual) new Notice("n8n Bridge: sync failed — " + errMsg(e));
		} finally {
			this.syncing = false;
			if (notice) window.setTimeout(() => notice.hide(), 4000);
		}
	}

	private async pushFile(path: string, mtime: number) {
		const buf = await this.app.vault.adapter.readBinary(path);
		const b64 = arrayBufferToBase64(buf);
		await this.syncFetch("/sync/file", {
			method: "POST",
			body: JSON.stringify({ path, mtime, base64: b64 }),
		});
	}

	private async pushDelete(path: string) {
		await this.syncFetch("/sync/file", {
			method: "POST",
			body: JSON.stringify({ path, mtime: Date.now(), deleted: true }),
		});
	}

	private async pullFile(path: string, mtime: number) {
		const res = await this.syncFetch(
			"/sync/file?path=" + encodeURIComponent(path),
			{ binary: true }
		);
		if (res.status < 200 || res.status >= 300) {
			console.warn(`n8n Bridge: pull ${path} HTTP ${res.status}`);
			return;
		}
		await this.ensureFolder(path);
		await this.app.vault.adapter.writeBinary(path, res.arrayBuffer, {
			mtime,
		});
	}

	private async deleteLocal(path: string) {
		const f = this.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) {
			// Route through trash if the user has it configured; false = respect setting.
			await this.app.vault.trash(f, false).catch(async () => {
				await this.app.vault.adapter.remove(path).catch(() => {});
			});
		}
	}
}

/* ------------------------------------------------------------------ */
/*  Settings tab                                                       */
/* ------------------------------------------------------------------ */

class N8nBridgeSettingTab extends PluginSettingTab {
	plugin: N8nBridgePlugin;

	constructor(app: App, plugin: N8nBridgePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "n8n Bridge" });
		containerEl.createEl("p", {
			text:
				"This device polls n8n for read/write jobs and can push the current note. " +
				"Give every device a UNIQUE name but the SAME secret, and register both in n8n.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("n8n base URL")
			.setDesc("Root of your n8n instance, no trailing slash.")
			.addText((t) =>
				t
					.setPlaceholder("https://demos25.me")
					.setValue(this.plugin.settings.baseUrl)
					.onChange(async (v) => {
						this.plugin.settings.baseUrl = v.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Device name")
			.setDesc("Unique id for THIS device. Claude targets a device by this name.")
			.addText((t) =>
				t
					.setPlaceholder("obsidian-phone")
					.setValue(this.plugin.settings.device)
					.onChange(async (v) => {
						this.plugin.settings.device = v.trim();
						await this.plugin.saveSettings();
						// New identity — reset auth warning and re-poll now so a
						// wrong value shows the "rejected" notice immediately.
						this.plugin.startPolling();
					})
			);

		new Setting(containerEl)
			.setName("Shared secret")
			.setDesc("Same value on every device and in n8n. Gates all requests.")
			.addText((t) => {
				t.inputEl.type = "password";
				t.setValue(this.plugin.settings.secret).onChange(async (v) => {
					this.plugin.settings.secret = v.trim();
					await this.plugin.saveSettings();
					this.plugin.startPolling();
				});
			})
			.addExtraButton((b) =>
				b
					.setIcon("refresh-cw")
					.setTooltip(
						"Generate a new secret (BREAKS the connection until n8n is updated to match!)"
					)
					.onClick(async () => {
						// A silent tap here once replaced a working secret and killed
						// the bridge for days. Require explicit confirmation.
						const sure = window.confirm(
							"Generate a NEW secret?\n\nThis will BREAK the bridge until you update the n8n workflows to accept the new secret. Only do this on purpose."
						);
						if (!sure) return;
						this.plugin.settings.secret = randomToken(24);
						await this.plugin.saveSettings();
						this.display();
						new Notice(
							"n8n Bridge: new secret generated — update your n8n workflows NOW or the bridge stays broken.",
							10000
						);
					})
			);

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Round-trip check: verifies URL, secret and device against n8n.")
			.addButton((b) =>
				b
					.setButtonText("Test now")
					.setCta()
					.onClick(async () => {
						b.setButtonText("Testing…").setDisabled(true);
						try {
							const url =
								this.plugin.trimBase() +
								this.plugin.settings.pollPath +
								`?device=${encodeURIComponent(this.plugin.settings.device)}` +
								`&secret=${encodeURIComponent(this.plugin.settings.secret)}`;
							const resp = await requestUrl({ url, method: "GET", throw: false });
							const body = (resp.json ?? {}) as any;
							if (resp.status >= 200 && resp.status < 300 && body.ok !== false) {
								new Notice(
									`✅ Connected! Server accepted device "${this.plugin.settings.device}". Pending jobs: ${body.count ?? 0}.`,
									8000
								);
							} else if (body.ok === false) {
								new Notice(
									`❌ Server rejected: ${body.error || "unauthorized"} — Secret or Device doesn't match n8n.`,
									10000
								);
							} else {
								new Notice(`❌ HTTP ${resp.status} — check the base URL / workflow is active.`, 10000);
							}
						} catch (e) {
							new Notice("❌ Network error: " + errMsg(e), 10000);
						} finally {
							b.setButtonText("Test now").setDisabled(false);
						}
					})
			);

		new Setting(containerEl)
			.setName("Enable background polling")
			.setDesc("When off, only manual 'Check n8n for jobs now' works.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.enablePolling).onChange(async (v) => {
					this.plugin.settings.enablePolling = v;
					await this.plugin.saveSettings();
					this.plugin.startPolling();
				})
			);

		new Setting(containerEl)
			.setName("Poll interval (seconds)")
			.setDesc("How often to check n8n for jobs. Higher = less battery/data.")
			.addText((t) =>
				t
					.setValue(String(this.plugin.settings.pollSeconds))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						this.plugin.settings.pollSeconds = isNaN(n) ? 5 : Math.max(2, n);
						await this.plugin.saveSettings();
						this.plugin.startPolling();
					})
			);

		new Setting(containerEl)
			.setName("Notify on each job")
			.setDesc("Show a toast whenever a job runs.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.notifyOnJob).onChange(async (v) => {
					this.plugin.settings.notifyOnJob = v;
					await this.plugin.saveSettings();
				})
			);

		containerEl.createEl("h3", { text: "MyAnimeList sync" });
		containerEl.createEl("p", {
			text: "Register an app at myanimelist.net/apiconfig, use the redirect URI obsidian://n8n-bridge-mal, then connect.",
			cls: "setting-item-description",
		});
		new Setting(containerEl)
			.setName("MAL Client ID")
			.setDesc("Public client ID from your MyAnimeList app.")
			.addText((t) =>
				t.setValue(this.plugin.settings.malClientId).onChange(async (v) => {
					this.plugin.settings.malClientId = v.trim();
					await this.plugin.saveSettings();
				})
			);
		new Setting(containerEl)
			.setName("MAL Client Secret")
			.setDesc("Keep this value private.")
			.addText((t) => {
				t.inputEl.type = "password";
				t.setValue(this.plugin.settings.malClientSecret).onChange(async (v) => {
					this.plugin.settings.malClientSecret = v.trim();
					await this.plugin.saveSettings();
				});
			});
		new Setting(containerEl)
			.setName("MyAnimeList account")
			.setDesc(this.plugin.settings.malAccessToken ? "Connected" : "Not connected")
			.addButton((b) => {
				b.setButtonText(this.plugin.settings.malAccessToken ? "Disconnect" : "Connect")
					.setCta()
					.onClick(async () => {
						if (this.plugin.settings.malAccessToken) {
							this.plugin.settings.malAccessToken = "";
							this.plugin.settings.malRefreshToken = "";
							this.plugin.settings.malTokenExpiresAt = 0;
							await this.plugin.saveSettings();
							this.display();
						} else {
							await this.plugin.startMalAuthorization();
						}
					});
			});
		new Setting(containerEl)
			.setName("Anime library")
			.setDesc("Import or refresh your complete MAL list with posters, metadata and episode progress.")
			.addButton((button) =>
				button
					.setButtonText("Import full list")
					.setCta()
					.onClick(() => this.plugin.importFullMalLibrary())
			);

		// MCP Server section
		containerEl.createEl("h3", { text: "MCP Server (for n8n/Claude integration)" });
		containerEl.createEl("p", {
			text: "Expose this vault as an MCP server so n8n workflows and Claude can read/write notes directly. Requires the n8n MCP Server workflow to be configured.",
			cls: "setting-item-description"
		});
		new Setting(containerEl)
			.setName("Enable MCP Server")
			.setDesc("Start a local MCP server on the specified port.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.mcpEnabled).onChange(async (v) => {
					this.plugin.settings.mcpEnabled = v;
					await this.plugin.saveSettings();
					this.plugin.toggleMcpServer(v);
				})
			);
		new Setting(containerEl)
			.setName("MCP Server Port")
			.setDesc("Local port for the MCP server (default 3001).")
			.addText((t) =>
				t.setPlaceholder("3001")
					.setValue(String(this.plugin.settings.mcpPort))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						this.plugin.settings.mcpPort = isNaN(n) ? 3001 : Math.max(1024, Math.min(65535, n));
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("MCP Server Name")
			.setDesc("Name shown in n8n/Claude for this vault.")
			.addText((t) =>
				t.setPlaceholder("Obsidian Vault")
					.setValue(this.plugin.settings.mcpName)
					.onChange(async (v) => {
						this.plugin.settings.mcpName = v.trim() || "Obsidian Vault";
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "Whole-vault sync" });
		containerEl.createEl("p", {
			text:
				"Two-way sync of the ENTIRE vault (notes + attachments) with our own " +
				"vault-sync server. Newest change wins by modified time. Use the same " +
				"URL and secret on every device.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Enable vault sync")
			.setDesc("Run a background sync loop on this device.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.syncEnabled).onChange(async (v) => {
					this.plugin.settings.syncEnabled = v;
					await this.plugin.saveSettings();
					this.plugin.startVaultSync();
				})
			);

		new Setting(containerEl)
			.setName("Sync server URL")
			.setDesc("Root of the vault-sync server, no trailing slash.")
			.addText((t) =>
				t
					.setPlaceholder("https://vaultsync.demos25.me")
					.setValue(this.plugin.settings.syncUrl)
					.onChange(async (v) => {
						this.plugin.settings.syncUrl = v.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Sync secret")
			.setDesc("Shared secret for the vault-sync server (x-bridge-secret).")
			.addText((t) => {
				t.inputEl.type = "password";
				t
					.setPlaceholder("vsync_…")
					.setValue(this.plugin.settings.syncSecret)
					.onChange(async (v) => {
						this.plugin.settings.syncSecret = v.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Sync interval (seconds)")
			.setDesc("How often to run a background sync (min 10).")
			.addText((t) =>
				t
					.setPlaceholder("30")
					.setValue(String(this.plugin.settings.syncSeconds))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						this.plugin.settings.syncSeconds = isNaN(n)
							? 30
							: Math.max(10, Math.min(3600, n));
						await this.plugin.saveSettings();
						this.plugin.startVaultSync();
					})
			);

		new Setting(containerEl)
			.setName("Sync now")
			.addButton((b) =>
				b
					.setButtonText("Sync vault now")
					.setCta()
					.onClick(() => this.plugin.syncVaultOnce(true))
			);

		containerEl.createEl("h3", { text: "Advanced: webhook paths" });
		for (const [key, label, desc] of [
			["pollPath", "Poll path", "GET endpoint returning pending jobs."],
			["resultPath", "Result path", "POST endpoint we send job results to."],
			["sendPath", "Send path", "POST endpoint for the manual 'send note' push."],
		] as const) {
			new Setting(containerEl)
				.setName(label)
				.setDesc(desc)
				.addText((t) =>
					t
						.setValue((this.plugin.settings as any)[key])
						.onChange(async (v) => {
							(this.plugin.settings as any)[key] = v.trim();
							await this.plugin.saveSettings();
						})
				);
		}

		new Setting(containerEl)
			.setName("Test connection")
			.addButton((b) =>
				b.setButtonText("Test now").setCta().onClick(() => this.plugin.testConnection())
			);
	}
}

/* ------------------------------------------------------------------ */
/*  utils                                                              */
/* ------------------------------------------------------------------ */

function randomToken(len: number): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	let out = "";
	// crypto is available on both desktop (Electron) and mobile (WebView).
	const cryptoObj = (globalThis as any).crypto;
	if (cryptoObj && cryptoObj.getRandomValues) {
		const buf = new Uint32Array(len);
		cryptoObj.getRandomValues(buf);
		for (let i = 0; i < len; i++) out += chars[buf[i] % chars.length];
	} else {
		for (let i = 0; i < len; i++)
			out += chars[Math.floor(Math.random() * chars.length)];
	}
	return out;
}

function errMsg(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}

/* Base64 <-> ArrayBuffer, chunked so large attachments don't blow the call
   stack. Works on both desktop (Electron) and mobile (WebView). */
function arrayBufferToBase64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let binary = "";
	const chunk = 0x8000; // 32KB per String.fromCharCode call
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode.apply(
			null,
			bytes.subarray(i, i + chunk) as unknown as number[]
		);
	}
	return btoa(binary);
}
