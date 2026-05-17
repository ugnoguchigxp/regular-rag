import {
	Activity,
	BookOpen,
	Bot,
	Database,
	GitBranch,
	RefreshCw,
	Search,
	Send,
	Settings,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
	type Artifact,
	type ChatCompletionResult,
	type ConversationItem,
	type ConversationMessage,
	type RetrievedFragment,
	type RetrievalLog,
	type SourceHealth,
	fetchConversationMessages,
	fetchConversations,
	fetchRetrievalLogs,
	fetchSourceCategories,
	fetchSourceHealth,
	searchFragments,
	sendChat,
} from "./api";
import { KnowledgeWorkspace } from "./knowledge-workspace";

type TabId = "knowledge" | "chat" | "search" | "settings";

type AppHealth = {
	status: string;
	service: string;
};

const tabItems: Array<{ id: TabId; label: string; icon: typeof BookOpen }> = [
	{ id: "knowledge", label: "Knowledge", icon: BookOpen },
	{ id: "chat", label: "Chat", icon: Bot },
	{ id: "search", label: "Search", icon: Search },
	{ id: "settings", label: "Settings", icon: Settings },
];

const toChatMessages = (
	messages: ConversationMessage[],
	nextUserMessage: string,
): Array<{ role: "system" | "user" | "assistant"; content: string }> => [
	...messages.map((message) => ({
		role: message.role,
		content: message.content,
	})),
	{ role: "user", content: nextUserMessage },
];

const formatDateTime = (value: string | null | undefined): string => {
	if (!value) return "-";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleString();
};

function renderArtifactContent(artifact: Artifact): string {
	if (typeof artifact.content === "string") {
		return artifact.content;
	}
	return JSON.stringify(artifact.content, null, 2);
}

const formatScore = (value: number | undefined): string =>
	typeof value === "number" ? value.toFixed(4) : "-";

const toResultTitle = (item: RetrievedFragment): string =>
	item.heading && item.heading.trim().length > 0
		? item.heading
		: item.sourceUri;

type RetrievalLogContextSummary = {
	retrievalStrategy?: string;
	selectedCount?: number;
	vectorCount?: number;
	textCount?: number;
	mergedCount?: number;
};

const toRetrievalLogContextSummary = (
	context: unknown,
): RetrievalLogContextSummary => {
	if (!context || typeof context !== "object" || Array.isArray(context)) {
		return {};
	}
	const value = context as Record<string, unknown>;
	const numberOrUndefined = (input: unknown): number | undefined =>
		typeof input === "number" ? input : undefined;
	return {
		retrievalStrategy:
			typeof value.retrievalStrategy === "string"
				? value.retrievalStrategy
				: undefined,
		selectedCount: numberOrUndefined(value.selectedCount),
		vectorCount: numberOrUndefined(value.vectorCount),
		textCount: numberOrUndefined(value.textCount),
		mergedCount: numberOrUndefined(value.mergedCount),
	};
};

export function App() {
	const [tab, setTab] = useState<TabId>("chat");
	const [busy, setBusy] = useState(false);
	const [errorText, setErrorText] = useState<string | null>(null);

	const [sourceHealth, setSourceHealth] = useState<SourceHealth | null>(null);
	const [appHealth, setAppHealth] = useState<AppHealth | null>(null);

	const [conversations, setConversations] = useState<ConversationItem[]>([]);
	const [activeConversationId, setActiveConversationId] = useState<
		string | null
	>(null);
	const [chatMessages, setChatMessages] = useState<ConversationMessage[]>([]);
	const [retrievalLogs, setRetrievalLogs] = useState<RetrievalLog[]>([]);
	const [latestChatResult, setLatestChatResult] =
		useState<ChatCompletionResult | null>(null);
	const [composerText, setComposerText] = useState("");
	const [availableCategories, setAvailableCategories] = useState<string[]>([
		"tech",
	]);
	const [chatCategory, setChatCategory] = useState("tech");
	const [searchCategory, setSearchCategory] = useState("tech");
	const [knowledgeSelection, setKnowledgeSelection] = useState<{
		slug: string | null;
		at: number;
	}>({ slug: null, at: 0 });

	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<{
		strategy: "merged" | "text_fallback" | "legacy_retrieve";
		selectedResults: RetrievedFragment[];
		vectorResults: RetrievedFragment[];
		textResults: RetrievedFragment[];
		mergedResults: RetrievedFragment[];
	} | null>(null);

	const conversationArtifacts = useMemo(
		() => chatMessages.flatMap((message) => message.artifacts ?? []),
		[chatMessages],
	);

	const loadHealth = async () => {
		const [source, app] = await Promise.all([
			fetchSourceHealth(),
			fetch("/api/health").then(async (res) => (await res.json()) as AppHealth),
		]);
		setSourceHealth(source);
		setAppHealth(app);
	};

	const loadConversations = async () => {
		const items = await fetchConversations(50);
		setConversations(items);
	};

	const loadCategories = async () => {
		const categories = await fetchSourceCategories();
		const normalized = categories.length > 0 ? categories : ["tech"];
		setAvailableCategories(normalized);
		setChatCategory((prev) => {
			if (prev === "all" || normalized.includes(prev)) return prev;
			return normalized.includes("tech") ? "tech" : (normalized[0] ?? "tech");
		});
		setSearchCategory((prev) => {
			if (prev === "all" || normalized.includes(prev)) return prev;
			return normalized.includes("tech") ? "tech" : (normalized[0] ?? "tech");
		});
	};

	const loadConversationDetails = async (conversationId: string) => {
		const [messages, logs] = await Promise.all([
			fetchConversationMessages(conversationId),
			fetchRetrievalLogs(conversationId, 20),
		]);
		setChatMessages(messages);
		setRetrievalLogs(logs);
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: initial load
	useEffect(() => {
		void (async () => {
			try {
				setErrorText(null);
				await Promise.all([
					loadHealth(),
					loadConversations(),
					loadCategories(),
				]);
			} catch (error) {
				setErrorText(
					error instanceof Error ? error.message : "Failed to load app.",
				);
			}
		})();
	}, []);

	const withBusy = async (task: () => Promise<void>) => {
		setBusy(true);
		setErrorText(null);
		try {
			await task();
		} catch (error) {
			setErrorText(
				error instanceof Error ? error.message : "Operation failed.",
			);
		} finally {
			setBusy(false);
		}
	};

	const handleSendMessage = async () => {
		const text = composerText.trim();
		if (!text) return;

		await withBusy(async () => {
			const result = await sendChat({
				conversationId: activeConversationId ?? undefined,
				messages: toChatMessages(chatMessages, text),
				topK: 8,
				category: chatCategory === "all" ? undefined : chatCategory,
			});
			setLatestChatResult(result);
			setComposerText("");
			setActiveConversationId(result.conversationId);
			await Promise.all([
				loadConversations(),
				loadConversationDetails(result.conversationId),
			]);
		});
	};

	const handleSelectConversation = async (conversationId: string) => {
		await withBusy(async () => {
			setActiveConversationId(conversationId);
			await loadConversationDetails(conversationId);
		});
	};

	const handleSearchFragments = async () => {
		const query = searchQuery.trim();
		if (!query) {
			setSearchResults(null);
			return;
		}
		await withBusy(async () => {
			const response = await searchFragments({
				query,
				topK: 12,
				category: searchCategory === "all" ? undefined : searchCategory,
			});
			setSearchResults({
				strategy: response.strategy,
				selectedResults: response.selectedResults,
				vectorResults: response.vectorResults,
				textResults: response.textResults,
				mergedResults: response.mergedResults,
			});
		});
	};

	const openKnowledgeFromSearch = (slug: string | null | undefined) => {
		if (!slug) return;
		setKnowledgeSelection((previous) => ({
			slug,
			at: previous.at + 1,
		}));
		setTab("knowledge");
	};

	const renderSearchResult = (
		item: RetrievedFragment,
		kind: "text" | "vector",
	) => {
		const primaryLabel = kind === "text" ? "text" : "vector";
		const primaryScore = kind === "text" ? item.textScore : item.vectorScore;
		const secondaryLabel = kind === "text" ? "vector" : "text";
		const secondaryScore = kind === "text" ? item.vectorScore : item.textScore;
		const resultTitle = toResultTitle(item);
		return (
			<article className="google-result">
				<div className="google-result-attribution">
					<span className="google-result-category">{item.sourceCategory}</span>
					<span className="google-result-uri">{item.sourceUri}</span>
					<span className="google-result-locator">{item.locator}</span>
				</div>
				<h4>
					{item.wikiSlug ? (
						<button
							type="button"
							className="google-result-title-link"
							onClick={() => openKnowledgeFromSearch(item.wikiSlug)}
							title={`Open wiki page: ${item.wikiSlug}`}
						>
							{resultTitle}
						</button>
					) : (
						<span className="google-result-title-disabled">{resultTitle}</span>
					)}
				</h4>
				<p>{item.content}</p>
				<div className="google-result-meta">
					<span>
						{primaryLabel}={formatScore(primaryScore)}
					</span>
					<span>
						{secondaryLabel}={formatScore(secondaryScore)}
					</span>
					<span>combined={formatScore(item.combinedScore)}</span>
				</div>
				<div className="google-result-links">
					{item.wikiSlug ? (
						<button
							type="button"
							className="google-link-btn"
							onClick={() => openKnowledgeFromSearch(item.wikiSlug)}
							title={`Open wiki page: ${item.wikiSlug}`}
						>
							wiki: {item.wikiSlug}
						</button>
					) : (
						<span className="google-link-disabled">wiki: unavailable</span>
					)}
					{item.wikiRawPath ? (
						<a
							href={item.wikiRawPath}
							target="_blank"
							rel="noreferrer"
							className="google-link-anchor"
							title="Open markdown document"
						>
							doc
						</a>
					) : (
						<span className="google-link-disabled">doc: unavailable</span>
					)}
				</div>
			</article>
		);
	};

	return (
		<div className="app-root">
			<header className="topbar">
				<div className="brand">
					<Database className="icon" />
					<span>regular-rag</span>
				</div>
				<nav className="tab-nav" aria-label="Primary">
					{tabItems.map((item) => {
						const Icon = item.icon;
						return (
							<button
								key={item.id}
								type="button"
								className={tab === item.id ? "tab active" : "tab"}
								onClick={() => setTab(item.id)}
							>
								<Icon className="icon" />
								<span>{item.label}</span>
							</button>
						);
					})}
				</nav>
			</header>

			{errorText ? <div className="status error">{errorText}</div> : null}

			{tab === "knowledge" ? (
				<KnowledgeWorkspace
					requestedSlug={knowledgeSelection.slug}
					requestedAt={knowledgeSelection.at}
				/>
			) : null}

			{tab === "chat" ? (
				<main className="layout columns-3">
					<section className="panel">
						<div className="panel-header">
							<h2>Conversations</h2>
							<div className="actions">
								<button
									type="button"
									title="Refresh conversations"
									onClick={() => void withBusy(loadConversations)}
									disabled={busy}
								>
									<RefreshCw className="icon" />
								</button>
							</div>
						</div>
						<div className="list">
							{conversations.map((conversation) => (
								<button
									key={conversation.id}
									type="button"
									className={
										activeConversationId === conversation.id
											? "list-item active"
											: "list-item"
									}
									onClick={() => void handleSelectConversation(conversation.id)}
								>
									<div>{conversation.title ?? "Conversation"}</div>
									<small>{formatDateTime(conversation.updatedAt)}</small>
								</button>
							))}
						</div>
					</section>

					<section className="panel">
						<div className="panel-header">
							<h2>Messages</h2>
						</div>
						<div className="chat-log">
							{chatMessages.map((message) => (
								<article
									key={message.id}
									className={`message message-${message.role}`}
								>
									<header>{message.role}</header>
									<p>{message.content}</p>
								</article>
							))}
						</div>
						<div className="composer">
							<div className="composer-controls">
								<label htmlFor="chat-category">Category</label>
								<select
									id="chat-category"
									value={chatCategory}
									onChange={(event) => setChatCategory(event.target.value)}
								>
									<option value="all">All categories</option>
									{availableCategories.map((category) => (
										<option key={category} value={category}>
											{category}
										</option>
									))}
								</select>
							</div>
							<textarea
								value={composerText}
								onChange={(event) => setComposerText(event.target.value)}
								placeholder="Ask with markdown context..."
							/>
							<button type="button" onClick={handleSendMessage} disabled={busy}>
								<Send className="icon" />
								<span>Send</span>
							</button>
						</div>
					</section>

					<section className="panel">
						<div className="panel-header">
							<h2>Artifacts</h2>
						</div>
						<div className="list">
							{conversationArtifacts.map((artifact) => (
								<article key={artifact.id} className="artifact-row">
									<header>
										<strong>{artifact.title ?? artifact.type}</strong>
										<small>v{artifact.version}</small>
									</header>
									<pre>{renderArtifactContent(artifact)}</pre>
								</article>
							))}
							{conversationArtifacts.length === 0 && latestChatResult ? (
								latestChatResult.citations.length > 0 ? (
									<article className="artifact-row">
										<header>
											<strong>Citations</strong>
										</header>
										<ul className="citation-list">
											{latestChatResult.citations.map((citation) => (
												<li key={citation.fragmentId}>
													{citation.title} ({citation.locator})
												</li>
											))}
										</ul>
									</article>
								) : null
							) : null}
						</div>
						<div className="panel-header sub">
							<h3>Retrieval Logs</h3>
						</div>
						<div className="list compact">
							{retrievalLogs.map((log) => (
								<div key={log.id} className="list-item">
									<div>{log.query}</div>
									{(() => {
										const summary = toRetrievalLogContextSummary(log.context);
										if (!summary.retrievalStrategy) return null;
										return (
											<small>
												strategy={summary.retrievalStrategy} selected=
												{summary.selectedCount ?? "-"} vector=
												{summary.vectorCount ?? "-"} text=
												{summary.textCount ?? "-"} merged=
												{summary.mergedCount ?? "-"}
											</small>
										);
									})()}
									<small>{formatDateTime(log.createdAt)}</small>
								</div>
							))}
						</div>
					</section>
				</main>
			) : null}

			{tab === "search" ? (
				<main className="layout columns-1">
					<section className="panel">
						<div className="panel-header">
							<h2>Fragment Search</h2>
						</div>
						<div className="search-row-advanced">
							<select
								value={searchCategory}
								onChange={(event) => setSearchCategory(event.target.value)}
								className="search-select"
							>
								<option value="all">All categories</option>
								{availableCategories.map((category) => (
									<option key={category} value={category}>
										{category}
									</option>
								))}
							</select>
							<div className="search-input-wrapper">
								<input
									value={searchQuery}
									onChange={(event) => setSearchQuery(event.target.value)}
									placeholder="Search knowledge fragments..."
									className="search-input"
									onKeyDown={(event) => {
										if (event.key === "Enter") {
											void handleSearchFragments();
										}
									}}
								/>
							</div>
							<button
								type="button"
								className="search-btn btn-primary"
								onClick={handleSearchFragments}
								disabled={busy}
							>
								<Search className="icon" />
								<span>Search</span>
							</button>
						</div>
						<div className="list search-list">
							{searchResults ? (
								<div className="search-results-grid">
									<div className="search-results-summary">
										<span>strategy={searchResults.strategy}</span>
										<span>selected={searchResults.selectedResults.length}</span>
										<span>merged={searchResults.mergedResults.length}</span>
									</div>
									<section className="search-results-column">
										<header className="search-results-column-header">
											<h3>Full-text Search</h3>
											<small>{searchResults.textResults.length} hits</small>
										</header>
										<div className="search-results-column-list">
											{searchResults.textResults.length > 0 ? (
												searchResults.textResults.map((item) => (
													<div key={`text-${item.id}`}>
														{renderSearchResult(item, "text")}
													</div>
												))
											) : (
												<div className="tree-info">No full-text hits.</div>
											)}
										</div>
									</section>
									<section className="search-results-column">
										<header className="search-results-column-header">
											<h3>Vector Search</h3>
											<small>{searchResults.vectorResults.length} hits</small>
										</header>
										<div className="search-results-column-list">
											{searchResults.vectorResults.length > 0 ? (
												searchResults.vectorResults.map((item) => (
													<div key={`vector-${item.id}`}>
														{renderSearchResult(item, "vector")}
													</div>
												))
											) : (
												<div className="tree-info">No vector hits.</div>
											)}
										</div>
									</section>
								</div>
							) : (
								<div className="tree-info">
									Run search to compare full-text and vector results side by
									side.
								</div>
							)}
						</div>
					</section>
				</main>
			) : null}

			{tab === "settings" ? (
				<main className="layout columns-2">
					<section className="panel">
						<div className="panel-header">
							<h2>API Health</h2>
						</div>
						<div className="meta-list">
							<div>
								<Activity />
								<span>{appHealth?.status ?? "-"}</span>
							</div>
							<div>
								<Database />
								<span>{appHealth?.service ?? "-"}</span>
							</div>
						</div>
					</section>
					<section className="panel">
						<div className="panel-header">
							<h2>Knowledge Git</h2>
						</div>
						<div className="meta-list">
							<div>
								<GitBranch />
								<span>{sourceHealth?.git?.branch ?? "-"}</span>
							</div>
							<div>
								<BookOpen />
								<span>{sourceHealth?.git?.commit ?? "-"}</span>
							</div>
						</div>
					</section>
				</main>
			) : null}
		</div>
	);
}
