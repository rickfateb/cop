#!/bin/sh
set -eu

SFTP_USERNAME="${SFTP_USERNAME:-cop_ingest}"
SFTP_PORT="${SFTP_PORT:-2222}"
: "${COP_SFTP_PASSWORD:?Configure COP_SFTP_PASSWORD no ambiente Railway}"

case "$SFTP_USERNAME" in
  *[!a-zA-Z0-9_-]*|'') echo "SFTP_USERNAME inválido" >&2; exit 1 ;;
esac
case "$SFTP_PORT" in
  *[!0-9]*|'') echo "SFTP_PORT inválida" >&2; exit 1 ;;
esac

if ! id "$SFTP_USERNAME" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$SFTP_USERNAME"
fi
printf '%s:%s\n' "$SFTP_USERNAME" "$COP_SFTP_PASSWORD" | chpasswd

mkdir -p /run/sshd /data/sftp/incoming /data/sftp/rejected
chown root:root /data/sftp
chmod 755 /data/sftp
chown -R "$SFTP_USERNAME:$SFTP_USERNAME" /data/sftp/incoming
chmod 750 /data/sftp/incoming
chown root:root /data/sftp/rejected
chmod 700 /data/sftp/rejected
ssh-keygen -A >/dev/null 2>&1

cat > /etc/ssh/sshd_config <<CFG
Port ${SFTP_PORT}
Protocol 2
HostKey /etc/ssh/ssh_host_rsa_key
HostKey /etc/ssh/ssh_host_ecdsa_key
HostKey /etc/ssh/ssh_host_ed25519_key
PasswordAuthentication yes
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PermitRootLogin no
UsePAM no
AllowUsers ${SFTP_USERNAME}
X11Forwarding no
AllowTcpForwarding no
PermitTunnel no
Subsystem sftp internal-sftp
Match User ${SFTP_USERNAME}
  ChrootDirectory /data/sftp
  ForceCommand internal-sftp -d /incoming -u 0027
  PasswordAuthentication yes
  AllowTcpForwarding no
  X11Forwarding no
CFG

/usr/sbin/sshd -f /etc/ssh/sshd_config -E /tmp/sshd.log
exec node src/server.js
