#!/usr/bin/env bash
set +x
set -Eeuo pipefail
umask 027

APP_DIR=/opt/restore
STATE_DIR=/var/lib/restore
CONFIG_DIR=/etc/restore
CACHE_DIR=/var/cache/restore
SERVICE_USER=restore-app
WEB_PORT=3300
API_PORT=8300
ACME_ROOT=/var/www/restore-acme
NGINX_SITE=/etc/nginx/sites-available/restore.conf
NGINX_LINK=/etc/nginx/sites-enabled/restore.conf
DEPLOY_GATE="$APP_DIR/.maintenance"
BACKUP_DIR="$STATE_DIR/backups"
DB_BACKUP="$BACKUP_DIR/pre-deploy.sqlite"
SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

WORK_DIR=''
RELEASE=''
PREVIOUS_RELEASE=''
CUTOVER=0
RELEASE_SWITCHED=0
DB_PATH=''
DB_EXISTED=0
STEP='проверка параметров'
TEAL='' GREEN='' RED='' RESET=''
if [[ -t 1 && -z ${NO_COLOR:-} ]]; then
  TEAL=$'\033[1;36m' GREEN=$'\033[1;32m' RED=$'\033[1;31m' RESET=$'\033[0m'
fi

usage() {
  cat <<'EOF'
ReStore · развёртывание на Ubuntu 26.04 LTS

  sudo bash deploy.sh
  sudo bash deploy.sh --domain restore-example
  bash deploy.sh --help

По умолчанию установщик предложит случайное имя
в формате restore-… и попросит добавить его в аккаунте DuckDNS.
--domain использует уже добавленный вами поддомен DuckDNS.

Для первой установки подготовьте токен DuckDNS, токен бота, Telegram ID
администратора и email для Let's Encrypt. Для VPS нужны публичный IPv4
и входящие TCP-порты 80 и 443. Повторный запуск обновляет код.
EOF
}

step() {
  STEP=$2
  printf '\n%s[%s/7] %s%s\n' "$TEAL" "$1" "$STEP" "$RESET"
}

die() {
  printf '%sОшибка:%s %s\n' "$RED" "$RESET" "$*" >&2
  exit 1
}

ask() {
  local -n answer=$1
  printf '%s ' "$2" >&2
  if [[ ${3:-} == secret ]]; then
    IFS= read -rs answer || die 'Ввод прерван.'
    printf '\n' >&2
  else
    IFS= read -r answer || die 'Ввод прерван.'
  fi
  [[ $answer != *$'\r'* ]] || die 'Уберите перенос строки в конце значения.'
}

set_env() {
  local key=$1 value=$2
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  printf '%s="%s"\n' "$key" "$value"
}

valid_label() {
  [[ $1 =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]
}

valid_email() {
  [[ $1 =~ ^[A-Za-z0-9._%+~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]
}

switch_release() {
  ln -sfnT -- "$1" "$APP_DIR/.current-next" && mv -Tf -- "$APP_DIR/.current-next" "$APP_DIR/current"
}

database_path() {
  local path
  path=$(systemd-run --quiet --wait --pipe --collect --property="EnvironmentFile=$CONFIG_DIR/backend.env" \
    /usr/bin/python3 -I -c 'import os; print(os.environ.get("DATABASE_PATH", ""))') \
    || die 'Не удалось прочитать DATABASE_PATH из backend.env.'
  [[ $path == /* && $path != *$'\n'* && $path != *$'\r'* ]] \
    || die 'Задайте абсолютный DATABASE_PATH в /etc/restore/backend.env.'
  DB_PATH=$(readlink -m -- "$path")
  [[ $DB_PATH == "$STATE_DIR/"* && $DB_PATH != "$BACKUP_DIR" && $DB_PATH != "$BACKUP_DIR/"* ]] \
    || die "База должна находиться в $STATE_DIR вне каталога резервных копий."
}

copy_database() {
  runuser -u "$SERVICE_USER" -- python3 -I - "$@" <<'PYTHON'
import os
import sqlite3
import sys
from contextlib import closing
from pathlib import Path
from tempfile import NamedTemporaryFile

source, target = map(Path, sys.argv[1:3])
restore = sys.argv[3] == 'restore'
with NamedTemporaryFile(dir=target.parent, prefix='.sqlite-', delete=False) as file:
    temporary = Path(file.name)
try:
    with closing(sqlite3.connect(f'{source.as_uri()}?mode=ro', uri=True)) as original:
        with closing(sqlite3.connect(temporary)) as copy:
            original.backup(copy)
            copy.execute('PRAGMA journal_mode=DELETE')
    if restore:
        for suffix in ('-wal', '-shm', '-journal'):
            Path(f'{target}{suffix}').unlink(missing_ok=True)
    os.replace(temporary, target)
finally:
    temporary.unlink(missing_ok=True)
PYTHON
}

save_database() {
  if [[ -e $DB_PATH ]]; then
    [[ -f $DB_PATH ]] || die "SQLite не является обычным файлом: $DB_PATH."
    install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$BACKUP_DIR"
    copy_database "$DB_PATH" "$DB_BACKUP" backup
    DB_EXISTED=1
    printf 'Резервная копия SQLite · %s\n' "$DB_BACKUP"
  fi
}

rollback_release() {
  systemctl stop restore-web.service restore-api.service || return 1
  if (( RELEASE_SWITCHED )); then
    if (( DB_EXISTED )); then
      copy_database "$DB_BACKUP" "$DB_PATH" restore || return 1
    else
      runuser -u "$SERVICE_USER" -- rm -f -- "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm" "$DB_PATH-journal" || return 1
    fi
  fi
  if [[ -n $PREVIOUS_RELEASE ]]; then
    switch_release "$PREVIOUS_RELEASE" && systemctl start restore-api.service restore-web.service || return 1
    wait_http 401 "http://127.0.0.1:$API_PORT/api/bootstrap" &&
      wait_http 200 "http://127.0.0.1:$WEB_PORT/" || return 1
  else
    systemctl disable restore-web.service restore-api.service && rm -f -- "$APP_DIR/current" || return 1
  fi
  rm -f -- "$DEPLOY_GATE"
}

on_exit() {
  local result=$?
  trap - EXIT
  trap '' INT TERM
  set +e
  if (( result != 0 )); then
    printf '\n%sУстановка остановилась%s · %s\n' "$RED" "$RESET" "$STEP" >&2
    if (( CUTOVER )); then
      if rollback_release; then
        printf 'Переключение отменено.\n' >&2
      else
        printf 'Откат не завершён. Режим обслуживания сохранён. Проверьте journalctl -u restore-api -u restore-web и копию %s.\n' "$DB_BACKUP" >&2
      fi
    fi
    if [[ $RELEASE == "$APP_DIR/releases/"* && -d $RELEASE && $(readlink -f "$APP_DIR/current") != "$RELEASE" ]]; then
      rm -rf -- "$RELEASE"
    fi
  fi
  [[ -z $WORK_DIR ]] || rm -rf -- "$WORK_DIR"
  exit "$result"
}

check_ports() {
  local port listener
  for port in 80 443; do
    while IFS= read -r listener; do
      if [[ -n $listener && $listener != *'("nginx",'* ]]; then
        die "Порт $port уже занят другой службой. Установщику нужен Nginx на 80 и 443."
      fi
    done <<<"$(ss -H -ltnp "sport = :$port")"
  done
  for port in "$WEB_PORT" "$API_PORT"; do
    local unit=restore-api.service
    [[ $port != "$WEB_PORT" ]] || unit=restore-web.service
    if ! systemctl is-active --quiet "$unit" && [[ -n $(ss -H -ltn "sport = :$port") ]]; then
      die "Порт $port занят. Освободите его для $unit."
    fi
  done
}

install_packages() {
  local -a apt=(apt-get -o Acquire::Retries=3 -o DPkg::Lock::Timeout=60)
  local package
  "${apt[@]}" update
  for package in nodejs npm certbot; do
    if ! apt-cache show "$package" >/dev/null 2>&1; then
      DEBIAN_FRONTEND=noninteractive "${apt[@]}" install -y software-properties-common
      add-apt-repository -y -n universe
      "${apt[@]}" update
      break
    fi
  done
  if ! command -v ss >/dev/null; then
    DEBIAN_FRONTEND=noninteractive "${apt[@]}" install -y iproute2
  fi
  check_ports
  DEBIAN_FRONTEND=noninteractive "${apt[@]}" install -y --no-install-recommends \
    ca-certificates curl openssl dnsutils nginx certbot nodejs npm python3 python3-venv
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 9) ? 0 : 1)' \
    || die 'Для сборки Next.js нужен Node.js 20.9 или новее.'
  printf 'Node.js %s · Python %s\n' "$(node --version)" "$(python3 -c 'import platform; print(platform.python_version())')"
}

install_dns_updater() {
  cat > "$WORK_DIR/duckdns-update" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

result=$(/usr/bin/curl -q -4 -fsS --max-time 15 --retry 2 --retry-max-time 35 --config - <<CURL
url = "https://www.duckdns.org/update?domains=${DUCKDNS_SUBDOMAIN:?}&token=${DUCKDNS_TOKEN:?}&verbose=true"
CURL
)
mapfile -t fields <<<"${result//$'\r'/}"
if [[ ${fields[0]:-} != OK || ! ${fields[1]:-} =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
  printf '%s\n' 'DuckDNS отклонил обновление. Проверьте токен и имя в аккаунте.' >&2
  exit 1
fi
if [[ -n ${RUNTIME_DIRECTORY:-} ]]; then
  printf '%s\n' "${fields[1]}" > "$RUNTIME_DIRECTORY/ipv4"
fi
printf '%s\n' "${fields[1]}"
EOF
  install -m 0755 "$WORK_DIR/duckdns-update" "$APP_DIR/duckdns-update"

  cat > /etc/systemd/system/restore-duckdns.service <<EOF
[Unit]
Description=ReStore DuckDNS update
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$SERVICE_USER
EnvironmentFile=$CONFIG_DIR/duckdns.env
RuntimeDirectory=restore-duckdns
RuntimeDirectoryPreserve=yes
ExecStart=$APP_DIR/duckdns-update
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
EOF
  cat > /etc/systemd/system/restore-duckdns.timer <<'EOF'
[Unit]
Description=Keep ReStore DNS up to date

[Timer]
OnBootSec=1min
OnCalendar=*:0/5
Persistent=true
Unit=restore-duckdns.service

[Install]
WantedBy=timers.target
EOF
}

telegram_json() {
  local action=$1 token=$2
  curl -q -fsS --connect-timeout 8 --max-time 15 --config - <<CURL
url = "https://api.telegram.org/bot${token}/${action}"
CURL
}

read_deployment() {
  local chosen=$1
  local -a metadata
  if [[ -s $CONFIG_DIR/deployment && -s $CONFIG_DIR/backend.env && -s $CONFIG_DIR/duckdns.env ]]; then
    mapfile -t metadata < "$CONFIG_DIR/deployment"
    DOMAIN=${metadata[0]:-}
    EMAIL=${metadata[1]:-}
    BOT_USERNAME=${metadata[2]:-}
    local existing=${DOMAIN%.duckdns.org}
    valid_label "$existing" && [[ $DOMAIN == "$existing.duckdns.org" ]] && valid_email "$EMAIL" \
      && [[ $BOT_USERNAME =~ ^[A-Za-z][A-Za-z0-9_]{3,31}$ ]] || die 'Повреждён файл /etc/restore/deployment.'
    [[ -z $chosen || $chosen == "$existing" ]] || die "ReStore уже настроен для $DOMAIN. Запустите обновление без --domain."
    printf 'Используем сохранённый домен %s.\n' "$DOMAIN"
    return
  fi

  local subdomain=$chosen suggestion duckdns_token bot_token admin_ids manager offer merchant_project merchant_key webhook ip
  if [[ -z $subdomain ]]; then
    suggestion="restore-$(openssl rand -hex 5)"
    printf '\nЗайдите на https://www.duckdns.org и добавьте поддомен %s.\n' "$suggestion"
    ask subdomain "Добавленный поддомен [$suggestion]:"
    subdomain=${subdomain:-$suggestion}
  fi
  subdomain=${subdomain,,}
  subdomain=${subdomain%.duckdns.org}
  valid_label "$subdomain" || die 'Укажите одно имя DuckDNS из букв a–z, цифр и дефисов.'
  DOMAIN="$subdomain.duckdns.org"
  ask duckdns_token 'Токен DuckDNS (скрыто):' secret
  [[ $duckdns_token =~ ^[[:xdigit:]]{8}(-[[:xdigit:]]{4}){3}-[[:xdigit:]]{12}$ ]] || die 'Ожидался токен DuckDNS в формате UUID.'
  if ! ip=$(DUCKDNS_SUBDOMAIN="$subdomain" DUCKDNS_TOKEN="$duckdns_token" "$APP_DIR/duckdns-update"); then
    die "Подтвердите, что $DOMAIN добавлен в вашем аккаунте DuckDNS."
  fi
  printf 'DuckDNS · %s → %s\n' "$DOMAIN" "$ip"

  ask bot_token 'Токен бота из BotFather (скрыто):' secret
  [[ $bot_token =~ ^[0-9]+:[a-zA-Z0-9_-]+$ ]] || die 'Токен бота должен быть в формате BotFather.'
  if ! BOT_USERNAME=$(telegram_json getMe "$bot_token" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["username"])'); then
    die 'Telegram не подтвердил токен бота.'
  fi
  [[ $BOT_USERNAME =~ ^[A-Za-z][A-Za-z0-9_]{3,31}$ ]] || die 'Telegram вернул некорректное имя бота.'
  if ! webhook=$(telegram_json getWebhookInfo "$bot_token" | python3 -c 'import json,sys; print(bool(json.load(sys.stdin)["result"]["url"]))'); then
    die 'Не удалось проверить, свободен ли бот для получения обновлений.'
  fi
  [[ $webhook == False ]] || die 'У бота зарегистрирован Telegram webhook. Освободите токен для getUpdates или используйте отдельного бота.'
  printf 'Бот · @%s\n' "$BOT_USERNAME"

  ask admin_ids 'Числовые Telegram ID администраторов через запятую:'
  admin_ids=${admin_ids//[[:blank:]]/}
  [[ $admin_ids =~ ^[0-9]{1,16}(,[0-9]{1,16})*$ ]] || die 'Укажите хотя бы один числовой Telegram ID.'
  ask EMAIL "Email для Let's Encrypt:"
  valid_email "$EMAIL" || die 'Укажите корректный email.'
  ask manager 'Username менеджера в Telegram [можно пусто]:'
  manager=${manager#@}
  [[ -z $manager || $manager =~ ^[A-Za-z][A-Za-z0-9_]{3,31}$ ]] || die 'Укажите username менеджера в Telegram.'
  ask offer 'HTTPS-ссылка на условия покупки [Enter — витрина без оформления]:'
  if [[ -n $offer ]]; then
    python3 -c 'import sys,urllib.parse; s=sys.argv[1]; u=urllib.parse.urlsplit(s); sys.exit(not(u.scheme=="https" and u.hostname and u.username is None and not any(c.isspace() for c in s)))' "$offer" \
      || die 'Оферта должна быть доступна по HTTPS-адресу.'
  fi
  if [[ -z $offer || -z $manager ]]; then
    printf '%s\n' 'Витрина запустится с отключённым оформлением. Для заказов укажите условия покупки и контакты менеджера в backend.env.'
  fi
  ask merchant_project 'ID проекта 2328.io [Enter, чтобы пропустить]:'
  merchant_key=''
  if [[ -n $merchant_project ]]; then
    [[ $merchant_project =~ ^[[:xdigit:]]{8}(-[[:xdigit:]]{4}){3}-[[:xdigit:]]{12}$ ]] || die 'Ожидался UUID проекта 2328.io.'
    ask merchant_key 'API-ключ 2328.io (скрыто):' secret
    [[ -n $merchant_key && ${#merchant_key} -le 512 && $merchant_key != *[[:space:]]* ]] || die 'Укажите API-ключ 2328.io.'
  fi

  {
    set_env BOT_TOKEN "$bot_token"
    set_env PUBLIC_URL "https://$DOMAIN"
    set_env ADMIN_IDS "$admin_ids"
    set_env MANAGER_USERNAME "$manager"
    set_env OFFER_URL "$offer"
    set_env DATABASE_PATH "$STATE_DIR/restore.sqlite"
    set_env PAY2328_PROJECT "$merchant_project"
    set_env PAY2328_API_KEY "$merchant_key"
  } > "$WORK_DIR/backend.env"
  {
    set_env DUCKDNS_SUBDOMAIN "$subdomain"
    set_env DUCKDNS_TOKEN "$duckdns_token"
  } > "$WORK_DIR/duckdns.env"
  printf '%s\n' "$DOMAIN" "$EMAIL" "$BOT_USERNAME" > "$WORK_DIR/deployment"
  install -m 0600 "$WORK_DIR/backend.env" "$CONFIG_DIR/backend.env"
  install -m 0600 "$WORK_DIR/duckdns.env" "$CONFIG_DIR/duckdns.env"
  install -m 0600 "$WORK_DIR/deployment" "$CONFIG_DIR/deployment"
}

check_dns() {
  local attempt expected addresses
  systemctl daemon-reload
  systemctl start restore-duckdns.service || die 'Обновление DuckDNS не прошло. Смотрите journalctl -u restore-duckdns.'
  [[ -s /run/restore-duckdns/ipv4 ]] || die 'Служба DuckDNS не записала подтверждённый IPv4.'
  expected=$(< /run/restore-duckdns/ipv4)
  systemctl enable --now restore-duckdns.timer
  for (( attempt=1; attempt<=24; attempt++ )); do
    addresses=$(dig +short +time=3 +tries=1 "$DOMAIN" A || true)
    if grep -Fxq -- "$expected" <<<"$addresses"; then
      printf 'DNS подтверждён · %s → %s\n' "$DOMAIN" "$expected"
      return
    fi
    sleep 5
  done
  die "DNS ещё не вернул $expected для $DOMAIN. После распространения записи запустите deploy.sh повторно."
}

build_release() {
  RELEASE=$(mktemp -d "$APP_DIR/releases/$(date +%Y%m%d-%H%M%S)-XXXXXXXX")
  cp -R -- "$SOURCE_DIR"/{app,backend,public} "$RELEASE/"
  cp -- "$SOURCE_DIR"/{package.json,package-lock.json,requirements.txt,next.config.ts,tsconfig.json} "$RELEASE/"
  find "$RELEASE/backend" -type d -name __pycache__ -prune -exec rm -r -- {} +
  chown -R "$SERVICE_USER:$SERVICE_USER" "$RELEASE"
  (
    cd -- "$RELEASE"
    runuser -u "$SERVICE_USER" -- python3 -m venv .venv
    runuser -u "$SERVICE_USER" -- .venv/bin/python -m pip install --no-cache-dir -r requirements.txt 'certifi>=2026.10.18'
    runuser -u "$SERVICE_USER" -- .venv/bin/python -m pip check
    runuser -u "$SERVICE_USER" -- env npm_config_cache="$CACHE_DIR/npm" npm ci --include=dev --no-audit --no-fund
    runuser -u "$SERVICE_USER" -- env NEXT_TELEMETRY_DISABLED=1 RESTORE_API_URL="http://127.0.0.1:$API_PORT" npm run build
  )
  chown -R "root:$SERVICE_USER" "$RELEASE"
  chmod 0750 "$RELEASE"
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$RELEASE/.next/cache"
}

apply_nginx() {
  local config=$1 previous="$WORK_DIR/nginx.previous" had_site=0 had_link=0
  if [[ -f $NGINX_SITE ]]; then
    cp -- "$NGINX_SITE" "$previous"
    had_site=1
  fi
  if [[ -L $NGINX_LINK ]]; then had_link=1; fi
  install -m 0644 "$config" "$NGINX_SITE"
  ln -sfnT -- "$NGINX_SITE" "$NGINX_LINK"
  if ! nginx -t || ! systemctl reload nginx; then
    if (( had_site )); then
      install -m 0644 "$previous" "$NGINX_SITE"
    else
      rm -f -- "$NGINX_SITE"
    fi
    if (( ! had_link )); then rm -f -- "$NGINX_LINK"; fi
    nginx -t && systemctl reload nginx || true
    die 'Nginx отклонил конфигурацию ReStore.'
  fi
}

render_nginx_http() {
  local action=$1 ipv6_listen=$2
  cat <<EOF
# Managed by ReStore deploy.sh
server {
    listen 80;
    $ipv6_listen
    server_name $DOMAIN;
    location ^~ /.well-known/acme-challenge/ {
        root $ACME_ROOT;
        try_files \$uri =404;
    }
    location / { return $action; }
}
EOF
}

check_acme_webroot() {
  local probe response="$WORK_DIR/acme-probe.response" status attempt
  probe=$(mktemp "$ACME_ROOT/.well-known/acme-challenge/restore-probe-XXXXXXXX")
  printf '%s\n' "${probe##*/}" > "$probe"
  chmod 0644 "$probe"
  for (( attempt=1; attempt<=5; attempt++ )); do
    status=$(curl -q --noproxy '*' -s --max-time 3 --resolve "$DOMAIN:80:127.0.0.1" \
      -o "$response" -w '%{http_code}' "http://$DOMAIN/.well-known/acme-challenge/${probe##*/}" || true)
    if [[ $status == 200 ]] && cmp -s -- "$probe" "$response"; then
      rm -f -- "$probe"
      printf 'Nginx отдаёт проверочный файл ACME локально.\n'
      return
    fi
    if (( attempt < 5 )); then sleep 1; fi
  done
  rm -f -- "$probe"
  die "Локальная проверка ACME для $DOMAIN не прошла (HTTP ${status:-000}). Проверьте, что sudo nginx -T показывает /etc/nginx/sites-enabled/restore.conf и что другой блок server не перехватывает этот домен. Проверьте /var/log/nginx/error.log и доступ Nginx к $ACME_ROOT."
}

configure_https() {
  local cert_name="restore-$DOMAIN" live="/etc/letsencrypt/live/restore-$DOMAIN" firewall ipv6_http='' ipv6_https=''
  if [[ -e /proc/net/if_inet6 ]]; then
    ipv6_http='listen [::]:80;'
    ipv6_https='listen [::]:443 ssl;'
  fi
  if [[ -e $NGINX_LINK || -L $NGINX_LINK ]]; then
    [[ -L $NGINX_LINK && $(readlink -f "$NGINX_LINK") == "$NGINX_SITE" ]] || die "$NGINX_LINK занят другой конфигурацией."
  fi
  if [[ -e $NGINX_SITE || -L $NGINX_SITE ]]; then
    if [[ -L $NGINX_SITE ]] || ! grep -Fxq '# Managed by ReStore deploy.sh' "$NGINX_SITE"; then
      die "$NGINX_SITE уже принадлежит другой конфигурации."
    fi
  fi
  install -d -m 0755 "$ACME_ROOT" "$ACME_ROOT/.well-known" "$ACME_ROOT/.well-known/acme-challenge"
  systemctl enable --now nginx

  if command -v ufw >/dev/null; then
    firewall=$(LC_ALL=C ufw status)
    if [[ $firewall == 'Status: active'* ]]; then
      ufw allow 80/tcp
      ufw allow 443/tcp
    fi
  fi

  if [[ ! -s $live/fullchain.pem || ! -s $live/privkey.pem || ! -L $NGINX_LINK ]]; then
    render_nginx_http '503' "$ipv6_http" > "$WORK_DIR/nginx.http"
    apply_nginx "$WORK_DIR/nginx.http"
  fi
  if [[ ! -s $live/privkey.pem ]] || ! openssl x509 -checkend 86400 -noout -in "$live/fullchain.pem" >/dev/null 2>&1; then
    check_acme_webroot
    if ! certbot certonly --webroot --webroot-path "$ACME_ROOT" --cert-name "$cert_name" \
      --domain "$DOMAIN" --email "$EMAIL" --agree-tos --non-interactive --keep-until-expiring; then
      die "Let's Encrypt не выпустил сертификат. Nginx отдаёт проверочный файл локально. Если CA получила 404, сравните публичные A/AAAA-записи с адресами VPS и проверьте, куда внешний прокси или NAT направляет TCP 80. Подробности в /var/log/letsencrypt/letsencrypt.log."
    fi
  fi

  render_nginx_http "308 https://$DOMAIN\$request_uri" "$ipv6_http" > "$WORK_DIR/nginx.tls"
  cat >> "$WORK_DIR/nginx.tls" <<EOF

map \$remote_addr \$restore_maintenance_file {
    127.0.0.1 /dev/null;
    default $DEPLOY_GATE;
}

server {
    listen 443 ssl;
    $ipv6_https
    server_name $DOMAIN;
    ssl_certificate $live/fullchain.pem;
    ssl_certificate_key $live/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 1m;
    open_file_cache off;

    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_http_version 1.1;

    if (-f \$restore_maintenance_file) {
        return 503;
    }
    location = /api/internal/deploy-ready {
        return 404;
    }
    location /api/ {
        proxy_pass http://127.0.0.1:$API_PORT;
    }
    location / {
        proxy_pass http://127.0.0.1:$WEB_PORT;
    }
}
EOF
  apply_nginx "$WORK_DIR/nginx.tls"
  install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
  cat > "$WORK_DIR/reload-nginx" <<EOF
#!/bin/sh
case " \${RENEWED_DOMAINS:-} " in
  *" $DOMAIN "*) systemctl reload nginx ;;
esac
EOF
  install -m 0755 "$WORK_DIR/reload-nginx" /etc/letsencrypt/renewal-hooks/deploy/90-restore-reload-nginx
  systemctl enable --now certbot.timer
}

install_app_units() {
  cat > /etc/systemd/system/restore-api.service <<EOF
[Unit]
Description=ReStore FastAPI and Telegram bot
After=network-online.target
Wants=network-online.target

[Service]
User=$SERVICE_USER
WorkingDirectory=$APP_DIR/current
EnvironmentFile=$CONFIG_DIR/backend.env
Environment=PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
Environment=RESTORE_DEPLOY_GATE=$DEPLOY_GATE
ExecStart=$APP_DIR/current/.venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port $API_PORT --workers 1 --forwarded-allow-ips 127.0.0.1
Restart=on-failure
RestartSec=3s
UMask=0027
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=$STATE_DIR

[Install]
WantedBy=multi-user.target
EOF
  cat > /etc/systemd/system/restore-web.service <<EOF
[Unit]
Description=ReStore Next.js
After=restore-api.service
Wants=restore-api.service

[Service]
User=$SERVICE_USER
WorkingDirectory=$APP_DIR/current
Environment=NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 RESTORE_API_URL=http://127.0.0.1:$API_PORT
ExecStart=/usr/bin/node $APP_DIR/current/node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port $WEB_PORT
Restart=on-failure
RestartSec=3s
UMask=0027
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=$APP_DIR/current/.next/cache

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
}

wait_http() {
  local want=$1 status attempt
  shift
  for (( attempt=1; attempt<=20; attempt++ )); do
    status=$(curl -q --noproxy '*' -s --max-time 4 -o /dev/null -w '%{http_code}' "$@" || true)
    [[ $status != "$want" ]] || return 0
    sleep 2
  done
  return 1
}

activate_release() {
  database_path
  CUTOVER=1
  touch -- "$DEPLOY_GATE"
  systemctl stop restore-web.service restore-api.service
  save_database
  switch_release "$RELEASE"
  RELEASE_SWITCHED=1
  systemctl start restore-api.service restore-web.service
  wait_http 401 "http://127.0.0.1:$API_PORT/api/bootstrap" || die 'FastAPI не ответил. Смотрите journalctl -u restore-api.'
  wait_http 200 "http://127.0.0.1:$WEB_PORT/" || die 'Next.js не ответил. Смотрите journalctl -u restore-web.'
  wait_http 200 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/" || die 'HTTPS-сайт не прошёл проверку.'
  wait_http 401 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/bootstrap" || die 'HTTPS-прокси API не прошёл проверку.'
  wait_http 200 "http://127.0.0.1:$API_PORT/api/internal/deploy-ready" \
    || die 'Telegram не ответил на getUpdates. Проверьте токен, webhook и доступ к Bot API.'
  systemctl enable restore-api.service restore-web.service
  trap '' INT TERM
  rm -f -- "$DEPLOY_GATE"
  CUTOVER=0
}

main() {
  local chosen='' part
  case ${1:-} in
    -h|--help) usage; return ;;
    --domain)
      [[ $# == 2 ]] || die 'Укажите имя после --domain.'
      chosen=${2,,}
      chosen=${chosen%.duckdns.org}
      valid_label "$chosen" || die 'Некорректное имя DuckDNS.' ;;
    '') ;;
    *) usage >&2; die 'Неизвестный аргумент.' ;;
  esac
  (( EUID == 0 )) || die 'Запустите sudo bash deploy.sh из каталога проекта.'
  [[ -r /etc/os-release ]] || die 'Ожидалась Ubuntu 26.04 LTS.'
  # shellcheck source=/dev/null
  . /etc/os-release
  [[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 26.04 && -d /run/systemd/system ]] \
    || die 'Нужен сервер Ubuntu 26.04 LTS с systemd.'
  exec 9>/run/lock/restore-deploy.lock
  flock -n 9 || die 'Другое развёртывание ReStore уже запущено.'
  [[ ! -e $DEPLOY_GATE ]] || die "Найден незавершённый деплой ($DEPLOY_GATE). Проверьте текущий релиз и SQLite перед снятием режима обслуживания."
  for part in app backend public package.json package-lock.json requirements.txt next.config.ts tsconfig.json; do
    [[ -e $SOURCE_DIR/$part ]] || die "Рядом с deploy.sh отсутствует $part. Скопируйте проект целиком."
  done
  WORK_DIR=$(mktemp -d)
  trap on_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  step 1 'Пакеты Ubuntu'
  install_packages
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$STATE_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
  install -d -m 0755 "$APP_DIR" "$APP_DIR/releases"
  install -d -m 0700 "$CONFIG_DIR"
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$STATE_DIR" "$CACHE_DIR"
  if [[ -e $APP_DIR/current || -L $APP_DIR/current ]]; then
    [[ -L $APP_DIR/current ]] || die "$APP_DIR/current занят неуправляемым каталогом."
    PREVIOUS_RELEASE=$(readlink -f "$APP_DIR/current")
    [[ $PREVIOUS_RELEASE == "$APP_DIR/releases/"* && -d $PREVIOUS_RELEASE ]] || die 'Ссылка текущей версии повреждена.'
    [[ -s $CONFIG_DIR/deployment && -s $CONFIG_DIR/backend.env && -s $CONFIG_DIR/duckdns.env ]] \
      || die 'Для обновления восстановите конфигурацию действующей установки из /etc/restore.'
  fi

  step 2 'Домен и данные бота'
  install_dns_updater
  read_deployment "$chosen"
  step 3 'DuckDNS и автообновление адреса'
  check_dns
  step 4 'Сборка Python и Next.js'
  build_release
  step 5 'Nginx и HTTPS'
  configure_https
  step 6 'Запуск служб ReStore'
  install_app_units
  activate_release
  step 7 'Готово'
  printf '%sReStore запущен%s\n' "$GREEN" "$RESET"
  printf '  Mini App  https://%s\n  Бот       https://t.me/%s\n' "$DOMAIN" "$BOT_USERNAME"
  printf '  Команды   /start · /admin\n  Данные    %s/restore.sqlite\n' "$STATE_DIR"
  printf '  Логи      journalctl -u restore-api -u restore-web -f\n'
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
