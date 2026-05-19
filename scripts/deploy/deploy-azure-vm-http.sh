#!/usr/bin/env bash
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-rg-nextjs-template-deploy}"
VM_NAME="${VM_NAME:-vm-nextjs-app}"
VM_USER="${VM_USER:-azureuser}"
SSH_HOST="${SSH_HOST:-13.78.45.101}"
APP_DOMAIN="${APP_DOMAIN:-products.dev.gxp.jp}"
START_VM="${START_VM:-true}"
RUN_VERIFY="${RUN_VERIFY:-false}"
RUNTIME_NODE_ENV="${RUNTIME_NODE_ENV:-${HTTP_NODE_ENV:-production}}"
APP_URL="${APP_URL:-http://$APP_DOMAIN}"
CORS_ORIGINS="${CORS_ORIGINS:-$APP_URL}"
AUTH_COOKIE_SECURE="${AUTH_COOKIE_SECURE:-false}"
SECURITY_HEADERS_MODE="${SECURITY_HEADERS_MODE:-http}"
BASIC_AUTH_USERNAME="${BASIC_AUTH_USERNAME:-regular-rag}"
BASIC_AUTH_PASSWORD="${BASIC_AUTH_PASSWORD:-}"
WIKI_STORAGE_BACKEND="${WIKI_STORAGE_BACKEND:-local}"
WIKI_BLOB_CONTAINER="${WIKI_BLOB_CONTAINER:-wiki-knowledge}"
WIKI_BLOB_PREFIX="${WIKI_BLOB_PREFIX:-}"
SSH_KEY="${SSH_KEY:-}"
RELEASE_TARBALL="regular-rag-release.tgz"
RUNTIME_ENV="regular-rag.env"
PROVISION_ENV="regular-rag-provision.env"

cd "$(dirname "$0")/../.."

if [[ -f .env ]]; then
	set -a
	# shellcheck disable=SC1091
	source .env
	set +a
fi

if [[ "$START_VM" == "true" ]]; then
	az vm start --resource-group "$RESOURCE_GROUP" --name "$VM_NAME"
fi

if [[ "$RUN_VERIFY" == "true" ]]; then
	bun run verify
else
	bun run build
fi

if [[ -z "${JWT_SECRET:-}" ]]; then
	echo "JWT_SECRET must be set in the environment or .env before deploying." >&2
	exit 1
fi
if [[ -z "$BASIC_AUTH_PASSWORD" ]]; then
	echo "BASIC_AUTH_PASSWORD must be set in the environment or .env before deploying." >&2
	exit 1
fi

{
	printf 'NODE_ENV=%s\n' "$RUNTIME_NODE_ENV"
	printf 'APP_URL=%s\n' "$APP_URL"
	printf 'CORS_ORIGINS=%s\n' "$CORS_ORIGINS"
	printf 'AUTH_COOKIE_SECURE=%s\n' "$AUTH_COOKIE_SECURE"
	printf 'SECURITY_HEADERS_MODE=%s\n' "$SECURITY_HEADERS_MODE"
	printf 'JWT_SECRET=%s\n' "$JWT_SECRET"
	printf 'AZURE_OPENAI_ENDPOINT=%s\n' "${AZURE_OPENAI_ENDPOINT:-}"
	printf 'AZURE_OPENAI_API_KEY=%s\n' "${AZURE_OPENAI_API_KEY:-}"
	printf 'AZURE_OPENAI_DEPLOYMENT=%s\n' "${AZURE_OPENAI_DEPLOYMENT:-gpt-5-4-mini}"
	printf 'AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT=%s\n' "${AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT:-text-embedding-3-small}"
	printf 'OPENAI_API_KEY=%s\n' "${OPENAI_API_KEY:-}"
	printf 'OPENAI_BASE_URL=%s\n' "${OPENAI_BASE_URL:-}"
	printf 'EXA_API_KEY=%s\n' "${EXA_API_KEY:-}"
	printf 'BRAVE_SEARCH_API_KEY=%s\n' "${BRAVE_SEARCH_API_KEY:-}"
	printf 'WIKI_STORAGE_BACKEND=%s\n' "$WIKI_STORAGE_BACKEND"
	printf 'AZURE_STORAGE_CONNECTION_STRING=%s\n' "${AZURE_STORAGE_CONNECTION_STRING:-}"
	printf 'WIKI_BLOB_CONTAINER=%s\n' "$WIKI_BLOB_CONTAINER"
	printf 'WIKI_BLOB_PREFIX=%s\n' "$WIKI_BLOB_PREFIX"
} >"$RUNTIME_ENV"
{
	printf 'ENABLE_BASIC_AUTH=true\n'
	printf 'BASIC_AUTH_USERNAME_B64=%s\n' "$(printf '%s' "$BASIC_AUTH_USERNAME" | base64 | tr -d '\n')"
	printf 'BASIC_AUTH_PASSWORD_B64=%s\n' "$(printf '%s' "$BASIC_AUTH_PASSWORD" | base64 | tr -d '\n')"
} >"$PROVISION_ENV"
chmod 600 "$PROVISION_ENV"

mkdir -p wiki-knowledge/pages

COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -czf "$RELEASE_TARBALL" \
	package.json \
	bun.lock \
	Dockerfile \
	docker-compose.yml \
	src \
	drizzle \
	dist-web \
	seed \
	wiki-knowledge

SSH_ARGS=(-o StrictHostKeyChecking=accept-new)
if [[ -n "$SSH_KEY" ]]; then
	SSH_ARGS+=(-i "$SSH_KEY")
fi

for attempt in $(seq 1 60); do
	if ssh "${SSH_ARGS[@]}" -o ConnectTimeout=5 "$VM_USER@$SSH_HOST" "true"; then
		break
	fi
	echo "Waiting for SSH to become reachable ($attempt/60)..."
	sleep 5
done

ssh "${SSH_ARGS[@]}" "$VM_USER@$SSH_HOST" "true"

scp "${SSH_ARGS[@]}" \
	"$RELEASE_TARBALL" \
	"$RUNTIME_ENV" \
	"$PROVISION_ENV" \
	scripts/deploy/azure-vm-provision.sh \
	"$VM_USER@$SSH_HOST:/tmp/"

ssh "${SSH_ARGS[@]}" "$VM_USER@$SSH_HOST" \
	"sudo APP_DOMAIN='$APP_DOMAIN' ENABLE_TLS=false PROVISION_ENV_SOURCE=/tmp/$PROVISION_ENV bash /tmp/azure-vm-provision.sh"

curl -fsS -u "$BASIC_AUTH_USERNAME:$BASIC_AUTH_PASSWORD" -H "Host: $APP_DOMAIN" "http://$SSH_HOST/api/health"
echo
echo "HTTP deploy smoke succeeded: http://$APP_DOMAIN via $SSH_HOST"
