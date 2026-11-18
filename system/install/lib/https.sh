# system/install/lib/https.sh — runs as root.
# Ilexarium on the network over HTTPS with its own certificate (ilex-https.socket, /etc/ilex/tls):
# the person's choice at the first install, kept in /etc/ilex/app.env (HTTPS_HOST, HTTPS_PORT).
# Sourced by install.sh.

TLS_DIR=/etc/ilex/tls
HTTPS_PORT_DEFAULT=3443
# 825 days: the longest Apple's systems accept for a server certificate.
CERT_DAYS=825
RENEW_DAYS=30

# Whether HTTPS on the network is on: HTTPS_HOST set in app.env.
https_on() { [[ -n "$(app_setting HTTPS_HOST)" ]]; }

https_port() {
  local port
  port="$(app_setting HTTPS_PORT)"
  printf '%s' "${port:-$HTTPS_PORT_DEFAULT}"
}

# The first install asks (default yes; --yes takes it, --local-only answers no); after that
# app.env decides — an update never asks and never changes it. Sets OPEN_ON_NETWORK.
choose_network() {
  OPEN_ON_NETWORK=0
  if [[ -n "$OLD_VERSION" ]] || grep -Eqs '^[[:space:]]*HTTPS_HOST=' "$ETC/app.env"; then
    if [[ "$LOCAL_ONLY" == 1 ]]; then info "--local-only: ignored, $ETC/app.env decides (HTTPS_HOST)"; fi
    return
  fi
  log 'Opening Ilexarium on your network'
  local question="Open Ilexarium from other devices (it listens on every IPv4 address of this machine, https://<address>:$(https_port))?"
  if [[ "$LOCAL_ONLY" == 1 ]]; then
    info "$question no (--local-only)"
    return
  fi
  if [[ "$ASSUME_YES" == 1 ]]; then
    info "$question yes (--yes)"
    OPEN_ON_NETWORK=1
    return
  fi
  if [[ ! -t 0 ]]; then die "$question — run again with --yes (opens it) or --local-only"; fi
  local answer
  while read -r -p "    $question [Y/n] " answer; do
    case "${answer,,}" in
      '' | y | yes)
        OPEN_ON_NETWORK=1
        return
        ;;
      n | no) return ;;
    esac
  done
  die "$question — no answer"
}

# The first install's answer, into app.env beside the settings ensure_app_settings wrote.
ensure_https_settings() {
  if [[ "$OPEN_ON_NETWORK" != 1 ]] || grep -Eqs '^[[:space:]]*HTTPS_HOST=' "$ETC/app.env"; then return; fi
  { cat "$ETC/app.env"
    cat <<CONF
# Ilexarium on your network over HTTPS, with its own certificate ($TLS_DIR). Without HTTPS_HOST
# only this machine reaches it (through your own proxy); after a change, run the installer again.
HTTPS_HOST=0.0.0.0
HTTPS_PORT=$(https_port)
CONF
  } | write_file "$ETC/app.env" "root:$APP_USER" 0640
  info "$ETC/app.env: HTTPS on the network, port $(https_port)"
}

# The machine's own addresses (not the containers' bridges), for the certificate and the link.
machine_addresses() {
  command -v ip >/dev/null || return 0
  ip -o addr show scope global 2>/dev/null |
    awk '$2 !~ /^(docker|br-|veth|virbr|cni|flannel)/ && !/temporary|deprecated/ { split($4, a, "/"); print a[1] }' |
    grep -E '^[0-9a-fA-F:.]+$' || true
}

# This machine's name, if it can be a certificate's DNS name.
machine_name() {
  local name
  name="$(cat /proc/sys/kernel/hostname 2>/dev/null || true)"
  if [[ "$name" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,62})(\.[A-Za-z0-9-]{1,63})*$ ]]; then printf '%s' "$name"; fi
}

# The certificate's names: this machine's name (and .local), localhost, its addresses.
certificate_names() {
  local name address names=()
  name="$(machine_name)"
  if [[ -n "$name" ]]; then
    names+=("DNS:$name")
    if [[ "$name" != *.* ]]; then names+=("DNS:$name.local"); fi
  fi
  names+=(DNS:localhost IP:127.0.0.1 IP:::1)
  while IFS= read -r address; do
    if [[ -n "$address" ]]; then names+=("IP:$address"); fi
  done < <(machine_addresses)
  local IFS=,
  printf '%s' "${names[*]}"
}

fingerprint() { openssl x509 -noout -fingerprint -sha256 -in "$1" 2>/dev/null | sed 's/^[^=]*=//'; }

# Whether the certificate there is the one this installer made: the marker holds its fingerprint
# (a certificate the person put in its place, marker or not, is theirs).
self_made() {
  local made
  made="$(cat "$TLS_DIR/.self-signed" 2>/dev/null || true)"
  [[ -n "$made" && "$made" == "$(fingerprint "$TLS_DIR/cert.pem")" ]]
}

# A self-signed certificate if none is there; one this installer made is renewed with fewer than
# RENEW_DAYS left. One the person put there is never touched.
ensure_certificate() {
  if ! https_on; then return; fi
  log 'The HTTPS certificate'
  ensure_dir "$TLS_DIR" root:root 0755
  local cert="$TLS_DIR/cert.pem" key="$TLS_DIR/key.pem"
  if [[ -e "$cert" || -e "$key" ]]; then
    if ! self_made; then
      info "$cert (yours, kept)"
      if [[ ! -e "$cert" || ! -e "$key" ]]; then warn "$TLS_DIR needs both cert.pem and key.pem"; fi
      if ! runuser -u "$APP_USER" -- test -r "$key"; then
        warn "$key isn't readable by the $APP_USER group: chown root:$APP_USER $key && chmod 0640 $key"
      fi
      return
    fi
    if [[ ! -e "$key" ]]; then
      info 'making the self-signed certificate again: its key is gone'
    elif openssl x509 -noout -checkend $((RENEW_DAYS * 86400)) -in "$cert" >/dev/null 2>&1; then
      info "$cert (self-signed, $(openssl x509 -noout -enddate -in "$cert" | sed 's/^notAfter=/valid until /'))"
      return
    else
      info 'renewing the self-signed certificate: fewer than 30 days left'
    fi
  fi
  make_certificate
}

make_certificate() {
  local work name
  work="$(mktemp -d "$TLS_DIR/.new.XXXXXX")"
  name="$(machine_name)"
  cat >"$work/openssl.cnf" <<CONF
[req]
distinguished_name = name
x509_extensions = extensions
prompt = no
[name]
CN = ${name:-Ilexarium}
O = Ilexarium (self-signed)
[extensions]
subjectAltName = $(certificate_names)
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
CONF
  if ! openssl req -x509 -new -config "$work/openssl.cnf" -newkey ec -pkeyopt ec_paramgen_curve:P-256 \
    -nodes -days "$CERT_DAYS" -keyout "$work/key.pem" -out "$work/cert.pem" >/dev/null 2>&1; then
    rm -rf "$work"
    die 'The HTTPS certificate could not be made (openssl)'
  fi
  chown "root:$APP_USER" "$work/key.pem"
  chmod 0640 "$work/key.pem"
  chmod 0644 "$work/cert.pem"
  fingerprint "$work/cert.pem" >"$work/.self-signed"
  chmod 0644 "$work/.self-signed"
  mv -f "$work/key.pem" "$TLS_DIR/key.pem"
  mv -f "$work/cert.pem" "$TLS_DIR/cert.pem"
  mv -f "$work/.self-signed" "$TLS_DIR/.self-signed"
  rm -rf "$work"
  info "$TLS_DIR/cert.pem (self-signed, $CERT_DAYS days: $(certificate_names))"
}

https_local_url() { local_url https "$(app_setting HTTPS_HOST)" "$(https_port)"; }

# The address to open from another device: HTTPS_HOST's own, or the machine's first address that
# HTTPS_HOST covers (0.0.0.0: IPv4 only).
https_link() {
  local host
  host="$(app_setting HTTPS_HOST)"
  case "$host" in
    0.0.0.0) host="$(machine_addresses | grep -v : | head -n1 || true)" ;;
    ::) host="$(machine_addresses | head -n1)" ;;
  esac
  case "$host" in
    '') host="<this machine's address>" ;;
    *:*) host="[$host]" ;;
  esac
  printf 'https://%s:%s' "$host" "$(https_port)"
}

# The socket on or off as app.env says; started with the app (start_app).
enable_https_socket() {
  if https_on; then
    systemctl enable ilex-https.socket >/dev/null 2>&1
    ensure_socket ilex-https.socket "$(local_address "$(app_setting HTTPS_HOST)")" "$(https_port)"
  else
    systemctl disable --now ilex-https.socket >/dev/null 2>&1 || true
  fi
}

# The app answers over HTTPS too. -k: only whether it answers, on this machine — a certificate of
# the person's own needn't name 127.0.0.1.
check_https() {
  if ! https_on; then return; fi
  local url end=$((SECONDS + 30))
  url="$(https_local_url)"
  while ((SECONDS < end)); do
    if curl -kfsS --max-time 3 "$url/api/health" 2>/dev/null | grep -qF "\"version\":\"$NEW_VERSION\""; then
      info "the app answers on $url, ilex-https.socket holds its port"
      return
    fi
    sleep 1
  done
  die "The app did not answer over HTTPS on $url (journalctl -u ilex)"
}

# A firewall that's on would keep the other devices out: says so (it opens nothing).
firewall_hint() {
  local port="$1"
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
    info "ufw is on: other devices reach port $port only once you allow it (sudo ufw allow $port/tcp)"
  fi
  if systemctl is-active --quiet firewalld 2>/dev/null; then
    info "firewalld is on: other devices reach port $port only once you allow it (sudo firewall-cmd --permanent --add-port=$port/tcp && sudo firewall-cmd --reload)"
  fi
}
