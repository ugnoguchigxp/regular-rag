import {
	Activity,
	Brain,
	BookOpen,
	Bot,
	Database,
	GitBranch,
	Search,
	Shield,
	Settings,
	Users,
	LogOut,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
	type AuthUser,
	type SourceHealth,
	fetchMe,
	fetchSourceCategories,
	fetchSourceHealth,
	fetchSystemContext,
	login,
	logout,
	UNAUTHORIZED_EVENT_NAME,
	updateSystemContext,
} from "./api";
import { AdminUserManagementPanel } from "./admin-user-management";
import { LoginDomainSection } from "./domains/auth/login-domain";
import { ChatDomainSection } from "./domains/chat/chat-domain";
import {
	KnowledgeDomainSection,
	KnowledgeNavigationProvider,
} from "./domains/knowledge/knowledge-domain";
import { SearchDomainSection } from "./domains/search/search-domain";

type TabId = "knowledge" | "chat" | "search" | "settings" | "admin";

type AppHealth = {
	status: string;
	service: string;
};

const formatDateTime = (value: string | null | undefined): string => {
	if (!value) return "-";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleString();
};

const isUnauthorizedError = (error: unknown): boolean =>
	error instanceof Error &&
	(error.message === "Unauthorized" || error.message.includes("401"));

export function App() {
	const [tab, setTab] = useState<TabId>("chat");
	const [busy, setBusy] = useState(false);
	const [errorText, setErrorText] = useState<string | null>(null);
	const [authUser, setAuthUser] = useState<AuthUser | null>(null);
	const [authLoading, setAuthLoading] = useState(true);

	const [sourceHealth, setSourceHealth] = useState<SourceHealth | null>(null);
	const [appHealth, setAppHealth] = useState<AppHealth | null>(null);

	const [availableCategories, setAvailableCategories] = useState<string[]>([
		"tech",
	]);
	const [systemContextText, setSystemContextText] = useState("");
	const [systemContextUpdatedAt, setSystemContextUpdatedAt] = useState<
		string | null
	>(null);
	const [systemContextSaving, setSystemContextSaving] = useState(false);

	const tabItems = useMemo<
		Array<{ id: TabId; label: string; icon: typeof BookOpen }>
	>(() => {
		const items: Array<{ id: TabId; label: string; icon: typeof BookOpen }> = [
			{ id: "knowledge", label: "Knowledge", icon: BookOpen },
			{ id: "chat", label: "Chat", icon: Bot },
			{ id: "search", label: "Search", icon: Search },
			{ id: "settings", label: "Settings", icon: Settings },
		];
		if (authUser?.role === "admin") {
			items.push({ id: "admin", label: "Admin", icon: Users });
		}
		return items;
	}, [authUser?.role]);

	const loadHealth = async () => {
		const [source, app] = await Promise.all([
			fetchSourceHealth(),
			fetch("/api/health").then(async (res) => (await res.json()) as AppHealth),
		]);
		setSourceHealth(source);
		setAppHealth(app);
	};

	const loadCategories = async () => {
		const categories = await fetchSourceCategories();
		const normalized = categories.length > 0 ? categories : ["tech"];
		setAvailableCategories(normalized);
	};

	const loadSystemContext = async () => {
		const settings = await fetchSystemContext();
		setSystemContextText(settings.systemContext);
		setSystemContextUpdatedAt(settings.updatedAt);
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: initial load
	useEffect(() => {
		void (async () => {
			try {
				setErrorText(null);
				const me = await fetchMe();
				setAuthUser(me);
				await Promise.all([
					loadHealth(),
					loadCategories(),
					loadSystemContext(),
				]);
			} catch (error) {
				if (!isUnauthorizedError(error)) {
					setErrorText(
						error instanceof Error ? error.message : "Failed to load app.",
					);
				}
			} finally {
				setAuthLoading(false);
			}
		})();
	}, []);

	useEffect(() => {
		if (tab === "admin" && authUser?.role !== "admin") {
			setTab("settings");
		}
	}, [tab, authUser?.role]);

	useEffect(() => {
		const onUnauthorized = () => {
			setAuthUser(null);
			setSystemContextText("");
			setSystemContextUpdatedAt(null);
			setTab("chat");
			setErrorText("Session expired. Please login again.");
		};
		window.addEventListener(UNAUTHORIZED_EVENT_NAME, onUnauthorized);
		return () => {
			window.removeEventListener(UNAUTHORIZED_EVENT_NAME, onUnauthorized);
		};
	}, []);

	const withBusy = async (task: () => Promise<void>): Promise<boolean> => {
		setBusy(true);
		setErrorText(null);
		try {
			await task();
			return true;
		} catch (error) {
			if (isUnauthorizedError(error)) {
				setAuthUser(null);
				setErrorText("Session expired. Please login again.");
			} else {
				setErrorText(
					error instanceof Error ? error.message : "Operation failed.",
				);
			}
			return false;
		} finally {
			setBusy(false);
		}
	};

	const handleLogin = async ({
		email,
		password,
	}: {
		email: string;
		password: string;
	}): Promise<boolean> => {
		if (!email || !password) return false;
		return await withBusy(async () => {
			const response = await login({ email, password });
			setAuthUser(response.user);
			await Promise.all([loadHealth(), loadCategories(), loadSystemContext()]);
		});
	};

	const handleLogout = async () => {
		await withBusy(async () => {
			await logout();
			setAuthUser(null);
			setSystemContextText("");
			setSystemContextUpdatedAt(null);
			setTab("chat");
		});
	};

	const handleSaveSystemContext = async () => {
		setSystemContextSaving(true);
		setErrorText(null);
		try {
			const updated = await updateSystemContext(systemContextText);
			setSystemContextText(updated.systemContext);
			setSystemContextUpdatedAt(updated.updatedAt);
		} catch (error) {
			setErrorText(
				error instanceof Error ? error.message : "Failed to save settings.",
			);
		} finally {
			setSystemContextSaving(false);
		}
	};

	return (
		<div className="app-root">
			<header className="topbar">
				<div className="brand">
					<Database className="icon" />
					<span>regular-rag</span>
				</div>
				{authUser ? (
					<div className="topbar-actions">
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
						<div className="auth-chip">
							<Shield className="icon" />
							<span>
								{authUser.displayName} ({authUser.role})
							</span>
						</div>
						<button
							type="button"
							className="tab"
							onClick={() => void handleLogout()}
							disabled={busy}
						>
							<LogOut className="icon" />
							<span>Logout</span>
						</button>
					</div>
				) : null}
			</header>

			{errorText ? <div className="status error">{errorText}</div> : null}

			{authLoading ? (
				<main className="layout columns-1">
					<section className="panel">
						<div className="tree-info">Loading session...</div>
					</section>
				</main>
			) : null}

			<LoginDomainSection
				active={!authLoading && !authUser}
				busy={busy}
				onLogin={handleLogin}
			/>

			{authUser ? (
				<KnowledgeNavigationProvider onOpenKnowledge={() => setTab("knowledge")}>
					<KnowledgeDomainSection active={tab === "knowledge"} />
					<ChatDomainSection
						active={tab === "chat"}
						busy={busy}
						runWithBusy={withBusy}
						availableCategories={availableCategories}
						setErrorText={setErrorText}
					/>
					<SearchDomainSection
						active={tab === "search"}
						busy={busy}
						runWithBusy={withBusy}
						availableCategories={availableCategories}
					/>
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
							<section className="panel">
								<div className="panel-header">
									<h2>System Context</h2>
								</div>
								<div className="form-stack">
									<label htmlFor="system-context-input">
										Agentic Search Prompt
									</label>
									<textarea
										id="system-context-input"
										value={systemContextText}
										onChange={(event) =>
											setSystemContextText(event.target.value)
										}
										placeholder="System context for this user..."
									/>
									<div className="actions">
										<button
											type="button"
											className="search-btn btn-primary"
											onClick={() => void handleSaveSystemContext()}
											disabled={systemContextSaving}
										>
											<Brain className="icon" />
											<span>Save</span>
										</button>
										<small>
											updated:{" "}
											{formatDateTime(systemContextUpdatedAt ?? undefined)}
										</small>
									</div>
								</div>
							</section>
						</main>
					) : null}
					{authUser.role === "admin" && tab === "admin" ? (
						<AdminUserManagementPanel
							busy={busy}
							runWithBusy={withBusy}
							setErrorText={setErrorText}
						/>
					) : null}
				</KnowledgeNavigationProvider>
			) : null}
		</div>
	);
}
