# Azure VM Deployment

`Deploy to Azure VM` GitHub Actions workflow deploys this app to the reused VM:

- Resource group: `rg-nextjs-template-deploy`
- VM: `vm-nextjs-app`
- SSH host default: `13.78.45.101`
- Domain default: `products.dev.gxp.jp`

The workflow does not query Azure for the public IP. It uses the manual `ssh_host` input as the SSH target. If `start_vm` is enabled, it only runs `az vm start` for the existing VM.

## VM Layout

```text
Nginx :80/:443
  -> 127.0.0.1:5173 regular-rag systemd service
      -> Hono API
      -> React dist-web static files
PostgreSQL + pgvector
  -> Docker Compose, bound to 127.0.0.1:5432
```

Application files are placed under `/opt/regular-rag/app`.

Persistent files:

- `/etc/regular-rag/regular-rag.env`
- `/var/lib/regular-rag/wiki-knowledge`
- Docker volume for PostgreSQL data

## Required GitHub Secrets

Required:

- `VM_SSH_PRIVATE_KEY`: private key for `azureuser`
- `JWT_SECRET`: 32+ character JWT signing secret
- `BASIC_AUTH_PASSWORD`: strong password for Nginx Basic authentication

Required for deploy-time VM start and the VM start/stop workflows:

- `AZURE_CREDENTIALS`: Azure service principal JSON for `azure/login`

Usually required for app functionality:

- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_API_KEY`

Optional:

- `AZURE_OPENAI_DEPLOYMENT`
- `AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT`
- `AZURE_STORAGE_CONNECTION_STRING`: required only when `WIKI_STORAGE_BACKEND=azure-blob`
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `EXA_API_KEY`
- `BRAVE_SEARCH_API_KEY`

Optional GitHub repository variables:

- `AZURE_VM_SCHEDULE_ENABLED`: set to `true` to enable weekday scheduled start/stop. Any other value, or an unset variable, keeps the schedule disabled.
- `BASIC_AUTH_USERNAME`: Basic auth username. Defaults to `regular-rag`.
- `WIKI_STORAGE_BACKEND`: `local` or `azure-blob`
- `WIKI_BLOB_CONTAINER`: defaults to `wiki-knowledge`
- `WIKI_BLOB_PREFIX`: optional prefix inside the container

## Manual Workflow Inputs

- `ssh_host`: fixed public IP or DNS name used for SSH.
- `app_domain`: Nginx `server_name` and Let's Encrypt certificate domain. Use `products.dev.gxp.jp`, not `https://products.dev.gxp.jp/`.
- `letsencrypt_email`: Let's Encrypt notice email.
- `run_verify`: runs the CI quality gate before packaging. This includes `actionlint` for GitHub Actions workflows.
- `start_vm`: starts `vm-nextjs-app` with Azure CLI before SSH.

Point `products.dev.gxp.jp` to the VM public IP or Azure DNS name before running the workflow. Certbot will fail if the domain does not resolve to the VM.

## Basic Authentication

Nginx Basic authentication is enabled by default for the public app. The deploy workflow requires `BASIC_AUTH_PASSWORD` as a GitHub secret and uses `BASIC_AUTH_USERNAME` as an optional repository variable.

The password is not written to the repository. During deployment, the VM provisioner creates `/etc/nginx/auth/regular-rag.htpasswd` with an Apache MD5 hash and stores it as `root:www-data` with `0640` permissions.

Let's Encrypt HTTP-01 challenge requests are exempt from Basic authentication:

```nginx
location /.well-known/acme-challenge/ {
    auth_basic off;
}
```

This lets certbot issue and renew certificates without needing Basic auth credentials while keeping the application itself protected.

## VM Start / Stop Workflows

The repository includes two power-control workflows:

- `Start Azure VM`: starts `vm-nextjs-app`
- `Stop Azure VM`: deallocates `vm-nextjs-app`

Both workflows can be run manually from GitHub Actions. They also run on weekdays using JST business hours:

| Workflow | JST | GitHub cron |
| --- | --- | --- |
| `Start Azure VM` | 10:00 Monday-Friday | `0 1 * * 1-5` |
| `Stop Azure VM` | 18:00 Monday-Friday | `0 9 * * 1-5` |

GitHub Actions cron is UTC, so these schedules are written as 01:00 UTC and 09:00 UTC.

Scheduled start/stop is disabled by default. To enable it, set repository variable `AZURE_VM_SCHEDULE_ENABLED=true` under `Settings > Secrets and variables > Actions > Variables`.
To disable the schedule again, set the variable to `false` or delete it. Manual runs still work while the scheduled gate is disabled.

The stop workflow uses `az vm deallocate`, not only `az vm stop`, so Azure compute billing is stopped for the VM while it is deallocated.

## Runtime Protocol Mode

Protocol-sensitive behavior is controlled by runtime environment variables, not by code changes:

| Mode | `APP_URL` | `AUTH_COOKIE_SECURE` | `SECURITY_HEADERS_MODE` |
| --- | --- | --- | --- |
| HTTP POC | `http://products.dev.gxp.jp` | `false` | `http` |
| HTTPS | `https://products.dev.gxp.jp` | `true` | `https` |

`CORS_ORIGINS` accepts a comma-separated list and defaults to the same origin as `APP_URL` in the deployment scripts.

## Local HTTP-Only Smoke Deploy

Before using Let's Encrypt, run the local HTTP deploy script. It deploys the same artifact path but invokes the VM provisioner with `ENABLE_TLS=false`, so Certbot is not called.
It writes `APP_URL=http://products.dev.gxp.jp`, `AUTH_COOKIE_SECURE=false`, and `SECURITY_HEADERS_MODE=http` by default so browser login works over plain HTTP without Secure cookies or HTTPS-only headers.

```bash
SSH_HOST=13.78.45.101 \
APP_DOMAIN=products.dev.gxp.jp \
RUN_VERIFY=false \
scripts/deploy/deploy-azure-vm-http.sh
```

The script reads `.env` if present, starts `vm-nextjs-app` by default, uploads the release tarball, provisions Nginx on port 80, and checks:

```bash
curl -H "Host: products.dev.gxp.jp" http://13.78.45.101/api/health
```

After HTTP deploy is stable and DNS points to the VM, run the GitHub Actions workflow with TLS enabled.

## Azure Blob Wiki Storage

The default wiki storage is local filesystem at `/var/lib/regular-rag/wiki-knowledge`.

To use Azure Blob Storage as the shared backing store, set these runtime values:

```env
WIKI_STORAGE_BACKEND=azure-blob
AZURE_STORAGE_CONNECTION_STRING=<storage-account-connection-string>
WIKI_BLOB_CONTAINER=wiki-knowledge
WIKI_BLOB_PREFIX=
```

Blob object names must match the local `wiki-knowledge` layout. For example:

```text
pages/tech/hono.md
pages/product/poc.md
```

If `WIKI_BLOB_PREFIX=poc/wiki`, place the same files below that prefix:

```text
poc/wiki/pages/tech/hono.md
poc/wiki/pages/product/poc.md
```

The app pulls Blob files into local `wiki-knowledge` on startup and before Wiki reads/reindexing. UI edits are pushed back to Blob after successful local write/commit operations. Use a dedicated container or dedicated prefix because files under the configured Blob scope that do not exist locally are deleted during push.

After uploading files directly to Blob, force a pull and index update on the VM:

```bash
sudo -u regular-rag env \
  HOME=/home/regular-rag \
  PATH=/home/regular-rag/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  bash -lc 'set -a; source /etc/regular-rag/regular-rag.env; set +a; cd /opt/regular-rag/app && bun run wiki:blob:pull && bun run wiki:index:all'
```

## Seed Users

The repository includes an idempotent user seed command and data file:

- `seed/users.json`
- `bun run db:seed:users`

The seed file defines two accounts without storing passwords in git:

| Email | Role | Password source |
| --- | --- | --- |
| `admin@example.com` | `admin` | `SEED_ADMIN_PASSWORD` |
| `member@example.com` | `member` | `SEED_MEMBER_PASSWORD` |

After deployment, run this on the VM to seed or reset those accounts:

```bash
sudo -u regular-rag env \
  HOME=/home/regular-rag \
  PATH=/home/regular-rag/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  SEED_ADMIN_PASSWORD='<admin-password>' \
  SEED_MEMBER_PASSWORD='<member-password>' \
  bash -lc 'set -a; source /etc/regular-rag/regular-rag.env; set +a; cd /opt/regular-rag/app && bun run db:seed:users'
```

For temporary POC credentials, generate missing passwords and copy them from the JSON output:

```bash
sudo -u regular-rag env \
  HOME=/home/regular-rag \
  PATH=/home/regular-rag/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  bash -lc 'set -a; source /etc/regular-rag/regular-rag.env; set +a; cd /opt/regular-rag/app && bun run db:seed:users -- --generate-missing-passwords'
```
