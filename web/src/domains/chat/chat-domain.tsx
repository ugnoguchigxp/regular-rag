import { RefreshCw, Send, Trash2 } from "lucide-react";
import mermaid from "mermaid";
import { MarkdownEditor } from "markdown-wysiwyg-editor";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	type Artifact,
	type ChatCompletionResult,
	type ConversationItem,
	type ConversationMessage,
	type RetrievalLog,
	deleteConversation,
	fetchConversationMessages,
	fetchConversations,
	fetchRetrievalLogs,
	sendChat,
} from "../../api";
import { normalizeAgenticAnswerMarkdown } from "../../agentic-markdown";

type RetrievalLogContextSummary = {
	retrievalStrategy?: string;
	selectedCount?: number;
	vectorCount?: number;
	textCount?: number;
	mergedCount?: number;
};

type ChatDomainSectionProps = {
	active: boolean;
	busy: boolean;
	runWithBusy: (task: () => Promise<void>) => Promise<boolean>;
	availableCategories: string[];
	setErrorText: (value: string | null) => void;
};

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

const renderArtifactContent = (artifact: Artifact): string => {
	if (typeof artifact.content === "string") {
		return artifact.content;
	}
	return JSON.stringify(artifact.content, null, 2);
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

export const ChatDomainSection = ({
	active,
	busy,
	runWithBusy,
	availableCategories,
	setErrorText,
}: ChatDomainSectionProps) => {
	const [conversations, setConversations] = useState<ConversationItem[]>([]);
	const [activeConversationId, setActiveConversationId] = useState<
		string | null
	>(null);
	const [chatMessages, setChatMessages] = useState<ConversationMessage[]>([]);
	const [retrievalLogs, setRetrievalLogs] = useState<RetrievalLog[]>([]);
	const [latestChatResult, setLatestChatResult] =
		useState<ChatCompletionResult | null>(null);
	const [composerText, setComposerText] = useState("");
	const [chatCategory, setChatCategory] = useState("tech");

	const conversationArtifacts = useMemo(
		() => chatMessages.flatMap((message) => message.artifacts ?? []),
		[chatMessages],
	);

	const loadConversations = useCallback(async () => {
		const items = await fetchConversations(50);
		setConversations(items);
	}, []);

	const loadConversationDetails = useCallback(
		async (conversationId: string) => {
			const [messages, logs] = await Promise.all([
				fetchConversationMessages(conversationId),
				fetchRetrievalLogs(conversationId, 20),
			]);
			setChatMessages(messages);
			setRetrievalLogs(logs);
		},
		[],
	);

	useEffect(() => {
		if (availableCategories.includes(chatCategory)) return;
		if (availableCategories.includes("tech")) {
			setChatCategory("tech");
			return;
		}
		setChatCategory(availableCategories[0] ?? "tech");
	}, [availableCategories, chatCategory]);

	useEffect(() => {
		void loadConversations().catch((error) => {
			setErrorText(
				error instanceof Error
					? error.message
					: "Failed to load conversations.",
			);
		});
	}, [loadConversations, setErrorText]);

	const handleSendMessage = async () => {
		const text = composerText.trim();
		if (!text) return;

		await runWithBusy(async () => {
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
		await runWithBusy(async () => {
			setActiveConversationId(conversationId);
			await loadConversationDetails(conversationId);
		});
	};

	const handleDeleteConversation = async (conversationId: string) => {
		if (!confirm("Are you sure you want to delete this conversation?")) return;
		await runWithBusy(async () => {
			await deleteConversation(conversationId);
			if (activeConversationId === conversationId) {
				setActiveConversationId(null);
				setChatMessages([]);
				setRetrievalLogs([]);
				setLatestChatResult(null);
			}
			await loadConversations();
		});
	};

	if (!active) return null;

	return (
		<main className="layout columns-3">
			<section className="panel">
				<div className="panel-header">
					<h2>Conversations</h2>
					<div className="actions">
						<button
							type="button"
							title="Refresh conversations"
							onClick={() => void runWithBusy(loadConversations)}
							disabled={busy}
						>
							<RefreshCw className="icon" />
						</button>
					</div>
				</div>
				<div className="list">
					{conversations.map((conversation) => (
						<div
							key={conversation.id}
							className={
								activeConversationId === conversation.id
									? "conversation-item-group active"
									: "conversation-item-group"
							}
						>
							<button
								type="button"
								className="conversation-select-btn"
								onClick={() => void handleSelectConversation(conversation.id)}
							>
								<div className="conversation-title">
									{conversation.title ?? "Conversation"}
								</div>
								<small className="conversation-date">
									{formatDateTime(conversation.updatedAt)}
								</small>
							</button>
							<button
								type="button"
								className="conversation-delete-btn"
								title="Delete conversation"
								onClick={(event) => {
									event.stopPropagation();
									void handleDeleteConversation(conversation.id);
								}}
								disabled={busy}
							>
								<Trash2 className="icon" />
							</button>
						</div>
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
							{message.role === "assistant" ? (
								<div className="chat-markdown-viewer">
									<MarkdownEditor
										value={normalizeAgenticAnswerMarkdown(message.content)}
										editable={false}
										enableMermaid={true}
										mermaidLib={mermaid}
										toolbarMode="hidden"
										autoHeight={true}
										className="wysiwyg-viewer"
									/>
								</div>
							) : (
								<p>{message.content}</p>
							)}
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
						onKeyDown={(event) => {
							if (event.key === "Enter" && event.ctrlKey) {
								event.preventDefault();
								void handleSendMessage();
							}
						}}
						placeholder="Ask with markdown context..."
					/>
					<button
						type="button"
						onClick={() => void handleSendMessage()}
						disabled={busy}
					>
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
										{summary.vectorCount ?? "-"} text={summary.textCount ?? "-"}{" "}
										merged={summary.mergedCount ?? "-"}
									</small>
								);
							})()}
							<small>{formatDateTime(log.createdAt)}</small>
						</div>
					))}
				</div>
			</section>
		</main>
	);
};
