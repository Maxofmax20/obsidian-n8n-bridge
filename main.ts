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
}

const DEFAULT_SETTINGS: N8nBridgeSettings = {
	baseUrl: "https://demos25.me",
	pollPath: "/webhook/obsidian-poll",
	resultPath: "/webhook/obsidian-result",
	sendPath: "/webhook/obsidian-send",
	device: "",
	secret: "",
	pollSeconds: 2,
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
		| "write_note"
		| "append_note"
		| "create_note"
		| "list_notes"
		| "search_vault"
		| "ping";
	path?: string; // vault-relative path, for note ops
	content?: string; // payload for write/append/create
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
	private pollGen = 0; // bumped to invalidate the running long-poll loop
	private polling = false; // re-entrancy guard
	private statusEl: HTMLElement | null = null;
	private animeSearchCache: Map<string, MalAnimeSearchResult> = new Map();

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

	/* ---------------- anime tracker + MyAnimeList ---------------- */

	private async renderAnimeTracker(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
		if (!(file instanceof TFile)) return;
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		let watched = Math.max(0, Number(frontmatter.watched) || 0);
		const episodes = Math.max(0, Number(frontmatter.episodes) || 0);
		let status = String(frontmatter.status || "Plan to Watch");
		const malId = Math.max(0, Number(frontmatter.mal_id) || 0);

		const root = el.createDiv({ cls: "anime-tracker" });

		// ── Header with anime info ──────────────────────────────────────
		const header = root.createDiv({ cls: "anime-tracker__header" });
		
		// If we have a MAL ID, fetch and show anime details
		if (malId) {
			try {
				const details = await this.getMalAnimeDetails(malId);
				if (details) {
					this.renderAnimeHeader(header, details, malId);
				}
			} catch (e) {
				console.debug("Failed to fetch anime details:", e);
			}
		}

		// ── Progress Section ───────────────────────────────────────────
		const progressSection = root.createDiv({ cls: "anime-tracker__section anime-tracker__section--progress" });
		const progressHeader = progressSection.createDiv({ cls: "anime-tracker__section-header" });
		progressHeader.createDiv({ cls: "anime-tracker__eyebrow", text: "YOUR PROGRESS" });
		
		const progressMain = progressSection.createDiv({ cls: "anime-tracker__progress-main" });
		const count = progressMain.createDiv({ cls: "anime-tracker__count" });
		const watchedEl = count.createSpan({ text: String(watched), cls: "anime-tracker__watched" });
		count.createSpan({ cls: "anime-tracker__total", text: ` / ${episodes || "?"} episodes` });
		
		const syncState = progressHeader.createDiv({ cls: "anime-tracker__sync" });
		const setSyncState = (text: string, mode = "") => {
			syncState.setText(text);
			syncState.className = `anime-tracker__sync ${mode}`.trim();
		};
		setSyncState(
			this.settings.malAccessToken ? "MAL connected" : "Local only",
			this.settings.malAccessToken ? "is-connected" : ""
		);

		const progressBarWrap = progressSection.createDiv({ cls: "anime-tracker__progress-bar-wrap" });
		const progress = progressBarWrap.createEl("input", { 
			cls: "anime-tracker__range", 
			type: "range",
			attr: { "aria-label": "Episodes watched" }
		});
		progress.min = "0";
		progress.max = String(episodes || 999);
		progress.step = "1";
		progress.value = String(watched);

		const quick = progressSection.createDiv({ cls: "anime-tracker__quick" });
		const minus = quick.createEl("button", { 
			cls: "anime-tracker__quick-btn", 
			attr: { "aria-label": "Remove one episode" } 
		});
		setIcon(minus, "minus");
		const plus = quick.createEl("button", { 
			cls: "anime-tracker__quick-btn", 
			attr: { "aria-label": "Add one episode" } 
		});
		setIcon(plus, "plus");

		// ── Stats Section ──────────────────────────────────────────────
		if (episodes > 0) {
			const statsSection = root.createDiv({ cls: "anime-tracker__section anime-tracker__section--stats" });
			const statsGrid = statsSection.createDiv({ cls: "anime-tracker__stats-grid" });
			
			const percent = Math.round((watched / episodes) * 100);
			const remaining = episodes - watched;
			
			this.createStatCard(statsGrid, "Progress", `${percent}%`, "percent");
			this.createStatCard(statsGrid, "Watched", `${watched}/${episodes}`, "watched");
			this.createStatCard(statsGrid, "Remaining", `${remaining} eps`, "remaining");
			this.createStatCard(statsGrid, "Status", status, "status");
		}

		// ── Status Section ─────────────────────────────────────────────
		const divider = root.createDiv({ cls: "anime-tracker__divider" });
		divider.setAttribute("aria-hidden", "true");
		const statusSection = root.createDiv({ cls: "anime-tracker__section anime-tracker__section--status" });
		statusSection.createDiv({ cls: "anime-tracker__label", text: "LIST STATUS" });
		const actions = statusSection.createDiv({ cls: "anime-tracker__actions" });

		let busy = false;
		const persist = async (nextWatched: number, nextStatus: string) => {
			if (busy) return;
			busy = true;
			watched = Math.max(0, Math.min(nextWatched, episodes || 999));
			status = nextStatus;
			watchedEl.setText(String(watched));
			progress.value = String(watched);
			
			// Update stats if visible
			if (episodes > 0) {
				const percent = Math.round((watched / episodes) * 100);
				const remaining = episodes - watched;
				root.querySelector(".anime-tracker__stat--percent .anime-tracker__stat-value")?.setText(`${percent}%`);
				root.querySelector(".anime-tracker__stat--watched .anime-tracker__stat-value")?.setText(`${watched}/${episodes}`);
				root.querySelector(".anime-tracker__stat--remaining .anime-tracker__stat-value")?.setText(`${remaining} eps`);
				root.querySelector(".anime-tracker__stat--status .anime-tracker__stat-value")?.setText(status);
			}
			
			setSyncState(this.settings.malAccessToken && malId ? "Syncing..." : "Saved locally");
			try {
				await this.app.fileManager.processFrontMatter(file, (fm) => {
					fm.watched = watched;
					fm.status = status;
				});
				if (this.settings.malAccessToken && malId) {
					await this.updateMalList(malId, watched, status);
					setSyncState("Synced with MAL", "is-connected");
				} else {
					setSyncState(malId ? "Saved locally" : "Missing MAL ID");
				}
			} catch (error) {
				setSyncState("Sync failed", "is-error");
				new Notice("Anime tracker: " + errMsg(error));
			} finally {
				busy = false;
			}
		};

		progress.addEventListener("change", () => persist(Number(progress.value), status));
		minus.addEventListener("click", () => persist(watched - 1, status));
		plus.addEventListener("click", () => persist(watched + 1, status));
		
		for (const label of Object.keys(MAL_STATUS)) {
			const button = actions.createEl("button", { text: label, cls: "anime-tracker__status-btn" });
			if (label === status) button.addClass("is-active");
			button.addEventListener("click", async () => {
				await persist(watched, label);
				actions.querySelectorAll("button").forEach((item) =>
					item.toggleClass("is-active", item === button)
				);
			});
		}

		// ── Search Section ─────────────────────────────────────────────
		const searchSection = root.createDiv({ cls: "anime-tracker__section anime-tracker__section--search" });
		const searchHeader = searchSection.createDiv({ cls: "anime-tracker__section-header" });
		searchHeader.createDiv({ cls: "anime-tracker__eyebrow", text: "DISCOVER" });
		
		const searchInput = searchSection.createEl("input", {
			cls: "anime-tracker__search-input",
			type: "search",
			placeholder: "Search anime on MyAnimeList…",
			attr: { "aria-label": "Search anime" }
		});
		
		const searchResults = searchSection.createDiv({ cls: "anime-tracker__search-results" });
		let searchDebounce: number;
		
		searchInput.addEventListener("input", () => {
			clearTimeout(searchDebounce);
			const query = searchInput.value.trim();
			if (query.length < 2) {
				searchResults.empty();
				searchResults.removeClass("has-results");
				return;
			}
			searchDebounce = window.setTimeout(() => this.performAnimeSearch(query, searchResults, file, malId), 300);
		});

		// ── Footer ─────────────────────────────────────────────────────
		const footer = root.createDiv({ cls: "anime-tracker__footer" });
		if (this.settings.malAccessToken && malId) {
			const pull = footer.createEl("button", { 
				text: "Pull from MyAnimeList",
				cls: "anime-tracker__footer-btn"
			});
			pull.addEventListener("click", async () => {
				try {
					setSyncState("Loading MAL...");
					const remote = await this.getMalListStatus(malId);
					if (!remote) throw new Error("This anime is not on your MAL list yet.");
					const localStatus = Object.keys(MAL_STATUS).find(
						(key) => MAL_STATUS[key] === remote.status
					) ?? "Plan to Watch";
					await persist(remote.num_episodes_watched || 0, localStatus);
				} catch (error) {
					setSyncState("Pull failed", "is-error");
					new Notice("MyAnimeList: " + errMsg(error));
				}
			});
		} else if (!this.settings.malAccessToken) {
			footer.createSpan({ text: "Connect MyAnimeList in n8n Bridge settings to sync." });
		} else {
			footer.createSpan({ text: "Add mal_id to this note to enable sync." });
		}
	}

	private renderAnimeHeader(header: HTMLElement, details: MalAnimeDetails, malId: number) {
		// Cover image
		if (details.main_picture?.medium) {
			const cover = header.createDiv({ cls: "anime-tracker__cover" });
			cover.createEl("img", {
				cls: "anime-tracker__cover-img",
				attr: { src: details.main_picture.medium, alt: details.title }
			});
		}

		// Title & meta
		const info = header.createDiv({ cls: "anime-tracker__info" });
		info.createEl("h3", { cls: "anime-tracker__title", text: details.title });
		
		if (details.alternative_titles?.en) {
			info.createDiv({ cls: "anime-tracker__alt-title", text: details.alternative_titles.en });
		}

		const meta = info.createDiv({ cls: "anime-tracker__meta" });
		
		if (details.num_episodes > 0) {
			meta.createSpan({ cls: "anime-tracker__meta-item", text: `${details.num_episodes} eps` });
		}
		if (details.mean > 0) {
			meta.createSpan({ cls: "anime-tracker__meta-item", text: `★ ${details.mean.toFixed(2)}` });
		}
		if (details.status) {
			const statusText = details.status.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase());
			meta.createSpan({ cls: "anime-tracker__meta-item", text: statusText });
		}
		if (details.genres?.length) {
			const genres = details.genres.slice(0, 3).map(g => g.name).join(", ");
			meta.createSpan({ cls: "anime-tracker__meta-item", text: genres });
		}

		// MAL link
		const link = info.createEl("a", {
			cls: "anime-tracker__mal-link",
			href: `https://myanimelist.net/anime/${malId}`,
			text: "Open on MyAnimeList ↗",
			attr: { target: "_blank", rel: "noopener noreferrer" }
		});
	}

	private createStatCard(grid: HTMLElement, label: string, value: string, type: string) {
		const card = grid.createDiv({ cls: `anime-tracker__stat anime-tracker__stat--${type}` });
		card.createDiv({ cls: "anime-tracker__stat-value", text: value });
		card.createDiv({ cls: "anime-tracker__stat-label", text: label });
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
			let created = 0;
			let updated = 0;
			for (let index = 0; index < entries.length; index++) {
				const entry = entries[index];
				const path = `Anime Library/Shows/${this.animeFileName(entry.node.title, entry.node.id)}.md`;
				const existing = this.app.vault.getAbstractFileByPath(path);
				const content = this.buildAnimeNote(entry, existing instanceof TFile ? await this.app.vault.read(existing) : "");
				if (existing instanceof TFile) {
					await this.app.vault.modify(existing, content);
					updated++;
				} else {
					await this.app.vault.create(path, content);
					created++;
				}
				if ((index + 1) % 25 === 0) notice.setMessage(`Imported ${index + 1} of ${entries.length} anime...`);
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

	private buildAnimeNote(entry: MalListEntry, existing: string): string {
		const anime = entry.node;
		const list = entry.list_status || (anime as any).my_list_status || {};
		const marker = "<!-- Your notes below this line are preserved during MAL refresh. -->";
		const personal = existing.includes(marker) ? existing.split(marker).slice(1).join(marker).trimStart() : "";
		const genres = (anime.genres || []).map((genre) => this.yamlString(genre.name)).join(", ");
		const englishTitle = anime.alternative_titles?.en || "";
		const note = [
			"---",
			"type: anime",
			`mal_id: ${anime.id}`,
			`title: ${this.yamlString(anime.title)}`,
			`english_title: ${this.yamlString(englishTitle)}`,
			`poster: ${this.yamlString(anime.main_picture?.large || anime.main_picture?.medium || "")}`,
			`mal_url: ${this.yamlString(`https://myanimelist.net/anime/${anime.id}`)}`,
			`status: ${this.yamlString(this.localAnimeStatus(list.status || "plan_to_watch"))}`,
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
			`# ${englishTitle || anime.title}`,
			"",
			"```anime-tracker",
			"```",
			"",
			marker,
			personal || "\n## Notes\n",
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

	toggleMcpServer(enabled: boolean) {
		if (enabled) {
			new Notice("MCP Server enabled on port " + this.settings.mcpPort + ". Configure n8n to connect to http://localhost:" + this.settings.mcpPort);
		} else {
			new Notice("MCP Server disabled");
		}
	}

	/* ---------------- poll loop ---------------- */

	startPolling() {
		this.stopPolling();
		if (!this.settings.enablePolling) {
			this.setStatus("paused");
			return;
		}
		this.pollGen++; // invalidate any in-flight loop from a previous start
		this.setStatus("idle");
		// Self-scheduling long-poll: each cycle starts only after the previous
		// one returns, so a held-open (long-poll) request never stacks. The
		// server holds the connection until a job appears or ~36s elapses, so
		// this is near-instant on a job yet makes very few requests when idle.
		this.pollLoop(this.pollGen);
	}

	private async pollLoop(gen: number) {
		while (gen === this.pollGen && this.settings.enablePolling) {
			await this.pollOnce(false);
			if (gen !== this.pollGen || !this.settings.enablePolling) return;
			// Tiny gap between held-open requests so a fast-returning empty
			// poll (e.g. server not in long-poll mode) can't hot-spin.
			const gapMs = Math.max(1, this.settings.pollSeconds) * 1000;
			await new Promise((r) => window.setTimeout(r, gapMs));
		}
	}

	stopPolling() {
		this.pollGen++; // any running loop sees gen change and exits
		if (this.pollTimer !== null) {
			window.clearInterval(this.pollTimer);
			this.pollTimer = null;
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
		try {
			await requestUrl({
				url: this.trimBase() + this.settings.resultPath,
				method: "POST",
				contentType: "application/json",
				headers: { "x-bridge-secret": this.settings.secret },
				body: JSON.stringify(payload),
				throw: false,
			});
		} catch (e) {
			console.error("n8n Bridge: failed to post result", e);
		}
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

	private trimBase(): string {
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
				});
			})
			.addExtraButton((b) =>
				b
					.setIcon("refresh-cw")
					.setTooltip("Generate a new secret")
					.onClick(async () => {
						this.plugin.settings.secret = randomToken(24);
						await this.plugin.saveSettings();
						this.display();
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
			.setName("Poll gap (seconds)")
			.setDesc(
				"Long-poll: each request holds open on the server until a job appears (~instant) or ~36s passes. This is the small pause between those held-open requests. 2–5 is fine; higher saves a little battery."
			)
			.addText((t) =>
				t
					.setValue(String(this.plugin.settings.pollSeconds))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						this.plugin.settings.pollSeconds = isNaN(n) ? 2 : Math.max(1, n);
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
