import {
	Activity,
	BookOpen,
	Bot,
	Database,
	FlaskConical,
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
	type RetrievalLog,
	type SourceHealth,
	fetchConversationMessages,
	fetchConversations,
	fetchRetrievalLogs,
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

	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<
		Array<{
			id: string;
			sourceUri: string;
			locator: string;
			heading: string | null;
			content: string;
			combinedScore: number;
		}>
	>([]);

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
				await Promise.all([loadHealth(), loadConversations()]);
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
			setSearchResults([]);
			return;
		}
		await withBusy(async () => {
			const response = await searchFragments({ query, topK: 12 });
			setSearchResults(response.results);
		});
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

			{tab === "knowledge" ? <KnowledgeWorkspace /> : null}

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
							<div className="actions">
								<button
									type="button"
									onClick={handleSearchFragments}
									disabled={busy}
								>
									<FlaskConical className="icon" />
									<span>Run</span>
								</button>
							</div>
						</div>
						<div className="search-row">
							<input
								value={searchQuery}
								onChange={(event) => setSearchQuery(event.target.value)}
								placeholder="Search query"
							/>
						</div>
						<div className="list">
							{searchResults.map((item) => (
								<article key={item.id} className="artifact-row">
									<header>
										<strong>{item.heading ?? item.sourceUri}</strong>
										<small>score={item.combinedScore.toFixed(4)}</small>
									</header>
									<small>{item.locator}</small>
									<p>{item.content}</p>
								</article>
							))}
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
