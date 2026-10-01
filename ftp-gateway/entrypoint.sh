#!/bin/sh
set -eu

: "${FTP_PASSWORD:?Configure FTP_PASSWORD}"
: "${FTP_PUBLIC_IP:?Configure FTP_PUBLIC_IP com o IP público da VPS}"
: "${COP_GATEWAY_TOKEN:?Configure COP_GATEWAY_TOKEN}"

FTP_USER="${FTP_USER:-cop_ftp}"
FTP_ROOT="${FTP_ROOT:-/srv/ftp}"
PASV_MIN="${FTP_PASV_MIN_PORT:-21000}"
PASV_MAX="${FTP_PASV_MAX_PORT:-21010}"

case "$FTP_USER" in *[!a-zA-Z0-9_-]*|'') echo 'FTP_USER inválido' >&2; exit 1;; esac

if ! id "$FTP_USER" >/dev/null 2>&1; then
  useradd -d "$FTP_ROOT" -s /usr/sbin/nologin "$FTP_USER"
fi
printf '%s:%s\n' "$FTP_USER" "$FTP_PASSWORD" | chpasswd
mkdir -p "$FTP_ROOT"
chown -R "$FTP_USER:$FTP_USER" "$FTP_ROOT"
chmod 750 "$FTP_ROOT"

IFS=','
for key in ${FTP_INGEST_KEYS:-}; do
  key=$(printf '%s' "$key" | tr -d ' ')
  [ -z "$key" ] && continue
  mkdir -p "$FTP_ROOT/$key"
  chown "$FTP_USER:$FTP_USER" "$FTP_ROOT/$key"
  chmod 750 "$FTP_ROOT/$key"
done
unset IFS

cat > /etc/vsftpd.conf <<CFG
listen=YES
listen_ipv6=NO
background=YES
anonymous_enable=NO
local_enable=YES
write_enable=YES
local_umask=027
file_open_mode=0660
chroot_local_user=YES
allow_writeable_chroot=YES
local_root=${FTP_ROOT}
pam_service_name=vsftpd
pasv_enable=YES
pasv_address=${FTP_PUBLIC_IP}
pasv_addr_resolve=NO
pasv_min_port=${PASV_MIN}
pasv_max_port=${PASV_MAX}
connect_from_port_20=YES
xferlog_enable=YES
xferlog_std_format=NO
log_ftp_protocol=YES
dual_log_enable=YES
vsftpd_log_file=/var/log/vsftpd.log
seccomp_sandbox=NO
ssl_enable=NO
utf8_filesystem=YES
CFG

touch /var/log/vsftpd.log
/usr/sbin/vsftpd /etc/vsftpd.conf
exec node /app/watcher.js
