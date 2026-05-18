import { ArrowRight, AtSign, Database, KeyRound, Shield } from "lucide-react";
import { useState } from "react";

type LoginDomainSectionProps = {
	active: boolean;
	busy: boolean;
	onLogin: (params: { email: string; password: string }) => Promise<boolean>;
};

export const LoginDomainSection = ({
	active,
	busy,
	onLogin,
}: LoginDomainSectionProps) => {
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");

	const handleSubmit = async () => {
		const nextEmail = email.trim();
		if (!nextEmail || !password) return;
		const ok = await onLogin({
			email: nextEmail,
			password,
		});
		if (ok) {
			setPassword("");
		}
	};

	if (!active) return null;

	return (
		<main className="auth-shell">
			<section className="auth-panel">
				<div className="auth-panel-header">
					<div className="auth-brand-row">
						<div className="auth-logo">
							<Database className="icon" />
						</div>
						<div>
							<h1>regular-rag</h1>
							<p>Admin Access</p>
						</div>
					</div>
					<div className="auth-accent-line" />
				</div>
				<div className="auth-form">
					<label htmlFor="login-email">Email</label>
					<div className="auth-input-wrap">
						<AtSign className="icon" />
						<input
							id="login-email"
							type="email"
							value={email}
							onChange={(event) => setEmail(event.target.value)}
							placeholder="admin@example.com"
							autoComplete="username"
						/>
					</div>
					<label htmlFor="login-password">Password</label>
					<div className="auth-input-wrap">
						<KeyRound className="icon" />
						<input
							id="login-password"
							type="password"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
							placeholder="********"
							autoComplete="current-password"
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									void handleSubmit();
								}
							}}
						/>
					</div>
					<button
						type="button"
						className="auth-submit"
						onClick={() => void handleSubmit()}
						disabled={busy}
					>
						<Shield className="icon" />
						<span>Sign In</span>
						<ArrowRight className="icon" />
					</button>
				</div>
			</section>
		</main>
	);
};
