#!/usr/bin/env bash
set -euo pipefail

APP_USER="regular-rag"
APP_ROOT="/opt/regular-rag"
APP_DIR="$APP_ROOT/app"
NEXT_DIR="$APP_ROOT/app.next"
WIKI_DIR="/var/lib/regular-rag/wiki-knowledge"
ENV_DIR="/etc/regular-rag"
ENV_FILE="$ENV_DIR/regular-rag.env"
RELEASE_TARBALL="${RELEASE_TARBALL:-/tmp/regular-rag-release.tgz}"
ENV_SOURCE="${ENV_SOURCE:-/tmp/regular-rag.env}"
APP_DOMAIN="${APP_DOMAIN:?APP_DOMAIN is required}"
ENABLE_TLS="${ENABLE_TLS:-true}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-}"
BUN_BIN="/home/$APP_USER/.bun/bin/bun"
BUN_ENV="HOME=/home/$APP_USER PATH=/home/$APP_USER/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

export DEBIAN_FRONTEND=noninteractive

APT_PACKAGES=(
	ca-certificates \
	curl \
	nginx \
	unzip
)
if [[ "$ENABLE_TLS" == "true" ]]; then
	APT_PACKAGES+=(python3-certbot-nginx)
	if [[ -z "$LETSENCRYPT_EMAIL" ]]; then
		echo "LETSENCRYPT_EMAIL is required when ENABLE_TLS=true" >&2
		exit 1
	fi
fi

apt-get update
apt-get install -y "${APT_PACKAGES[@]}"

if ! command -v docker >/dev/null 2>&1; then
	if apt-cache policy docker-ce 2>/dev/null | grep -q "Candidate:"; then
		apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
	else
		apt-get install -y docker.io docker-compose-plugin
	fi
fi

if ! docker compose version >/dev/null 2>&1; then
	apt-get install -y docker-compose-plugin
fi

systemctl enable --now docker

if ! id "$APP_USER" >/dev/null 2>&1; then
	useradd --system --create-home --shell /bin/bash "$APP_USER"
fi

install -d -m 755 "$APP_ROOT"
install -d -m 755 "$(dirname "$WIKI_DIR")"
install -d -m 750 -o root -g "$APP_USER" "$ENV_DIR"

if [[ -f "$ENV_SOURCE" ]]; then
	install -m 640 -o root -g "$APP_USER" "$ENV_SOURCE" "$ENV_FILE"
elif [[ ! -f "$ENV_FILE" ]]; then
	echo "Missing runtime env file: $ENV_SOURCE" >&2
	exit 1
fi

if ! sudo -u "$APP_USER" env $BUN_ENV bash -lc "command -v bun >/dev/null 2>&1"; then
	sudo -u "$APP_USER" env $BUN_ENV bash -lc "curl -fsSL https://bun.sh/install | bash"
fi

rm -rf "$NEXT_DIR"
install -d -m 755 "$NEXT_DIR"
tar -xzf "$RELEASE_TARBALL" -C "$NEXT_DIR"

if [[ -d "$NEXT_DIR/wiki-knowledge" && ! -d "$WIKI_DIR/pages" ]]; then
	rm -rf "$WIKI_DIR"
	cp -a "$NEXT_DIR/wiki-knowledge" "$WIKI_DIR"
fi
rm -rf "$NEXT_DIR/wiki-knowledge"
install -d -m 755 "$WIKI_DIR"
ln -s "$WIKI_DIR" "$NEXT_DIR/wiki-knowledge"

chown -R "$APP_USER:$APP_USER" "$APP_ROOT" "$WIKI_DIR"

if [[ -d "$APP_DIR" ]]; then
	rm -rf "$APP_ROOT/app.prev"
	mv "$APP_DIR" "$APP_ROOT/app.prev"
fi
mv "$NEXT_DIR" "$APP_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

cd "$APP_DIR"
sudo -u "$APP_USER" env $BUN_ENV "$BUN_BIN" install --frozen-lockfile --production

docker compose up -d --build --remove-orphans db
PG_READY_COUNT=0
for _ in $(seq 1 60); do
	if docker exec regular-rag-db pg_isready -U postgres >/dev/null 2>&1; then
		PG_READY_COUNT=$((PG_READY_COUNT + 1))
		if [[ "$PG_READY_COUNT" -ge 2 ]]; then
			break
		fi
	else
		PG_READY_COUNT=0
	fi
	sleep 2
done
docker exec regular-rag-db pg_isready -U postgres

sudo -u "$APP_USER" env $BUN_ENV bash -lc "set -a; source '$ENV_FILE'; set +a; cd '$APP_DIR' && bun run db:migrate"

cat >/etc/systemd/system/regular-rag.service <<EOF
[Unit]
Description=Regular RAG Hono server
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
Environment=PATH=/home/$APP_USER/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=$BUN_BIN run src/app/server.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable regular-rag
systemctl restart regular-rag

cat >/etc/nginx/sites-available/regular-rag <<EOF
server {
	listen 80;
	server_name $APP_DOMAIN;

	client_max_body_size 20m;

	location / {
		proxy_pass http://127.0.0.1:5173;
		proxy_http_version 1.1;
		proxy_set_header Host \$host;
		proxy_set_header X-Real-IP \$remote_addr;
		proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
		proxy_set_header X-Forwarded-Proto \$scheme;
		proxy_read_timeout 300s;
		proxy_send_timeout 300s;
	}
}
EOF

ln -sf /etc/nginx/sites-available/regular-rag /etc/nginx/sites-enabled/regular-rag
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx
systemctl restart nginx

if [[ "$ENABLE_TLS" == "true" ]]; then
	certbot --nginx \
		-d "$APP_DOMAIN" \
		--non-interactive \
		--agree-tos \
		--no-eff-email \
		-m "$LETSENCRYPT_EMAIL" \
		--redirect
	systemctl reload-or-restart nginx
else
	echo "Skipping Let's Encrypt because ENABLE_TLS=$ENABLE_TLS"
fi

systemctl status regular-rag --no-pager
curl -fsS http://127.0.0.1:5173/api/health
