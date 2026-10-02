#!/usr/bin/env python3
"""Interactive VPS setup. No credentials in CLI arguments, history, or repository."""
import getpass
import grp
import json
import os
import pathlib
import pwd
import shutil
import subprocess
import tempfile
from relay import portal_config

def main():
    if os.geteuid() != 0:
        raise SystemExit("Execute como root no VPS.")
    root = pathlib.Path(__file__).resolve().parent
    if root.parent != pathlib.Path("/opt/cop-sdk-pilot"):
        raise SystemExit("Instale o código em /opt/cop-sdk-pilot.")
    config_path = pathlib.Path("/etc/cop-sdk/config.json")
    if config_path.exists():
        raise SystemExit("Configuração já existe. Para alterações, use sudoedit /etc/cop-sdk/config.json e reinicie cop-sdk-relay.")
    for program in ("ffmpeg", "ffprobe", "g++", "systemctl"):
        if not shutil.which(program):
            raise SystemExit("Dependência ausente: " + program)
    sdk = pathlib.Path("/opt/intelbras-sdk")
    if not (sdk / "bin/libdhnetsdk.so").is_file():
        raise SystemExit("SDK Linux não encontrado em /opt/intelbras-sdk/bin.")
    token = getpass.getpass("Token exclusivo do conector COP (entrada oculta): ").strip()
    if len(token) < 32:
        raise SystemExit("Token deve ter pelo menos 32 caracteres.")
    remote = portal_config({"cop_url":"https://cop.cobile.com.br","connector_token":token})
    if remote:
        if not remote["devices"]:
            raise SystemExit("Cadastre um dispositivo SDK ativo com senha e vincule-o a este servidor no COP.")
        devices=remote["devices"]
    else:
        device_id = input("ID de Auto Registro [101]: ").strip() or "101"
        username = input("Usuário do DVR [admin]: ").strip() or "admin"
        password = getpass.getpass("Senha do DVR Cerejeiras (entrada oculta): ")
        if not password:
            raise SystemExit("Senha vazia.")
        devices=[{"id":device_id,"username":username,"password":password}]
    subprocess.run(["sh", str(root / "build.sh")], check=True,
                   env={**os.environ, "NETSDK_INCLUDE": str(sdk / "include")})
    os.chmod(root / "build", 0o755)
    os.chmod(root / "build/cop-sdk-receiver", 0o755)
    try:
        user = pwd.getpwnam("cop-pilot")
    except KeyError:
        subprocess.run(["useradd", "--system", "--user-group", "--create-home",
                        "--home-dir", "/var/lib/cop-pilot", "--shell", "/usr/sbin/nologin", "cop-pilot"], check=True)
        user = pwd.getpwnam("cop-pilot")
    group = grp.getgrnam("cop-pilot")
    state = pathlib.Path(remote["state_dir"] if remote else "/var/lib/cop-pilot/sdk-jobs")
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chown(state, user.pw_uid, group.gr_gid)
    os.chmod(state, 0o700)
    config_path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    os.chown(config_path.parent, 0, group.gr_gid)
    config = {"cop_url": "https://cop.cobile.com.br", "connector_name": remote["connector_name"] if remote else "hostinger",
              "portal_managed": bool(remote),
              "connector_token": token, "sdk_so": str(sdk / "bin/libdhnetsdk.so"),
              "receiver": str(root / "build/cop-sdk-receiver"), "state_dir": str(state),
              "bind": "0.0.0.0", "port": remote["port"] if remote else 8000,
              "devices": [] if remote else devices}
    fd, temporary = tempfile.mkstemp(dir=config_path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(config, output)
        os.chown(temporary, 0, group.gr_gid)
        os.chmod(temporary, 0o640)
        os.replace(temporary, config_path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    unit=(root / "cop-sdk-relay.service").read_text().replace("ReadWritePaths=/var/lib/cop-pilot","ReadWritePaths=/var/lib/cop-pilot " + str(state))
    pathlib.Path("/etc/systemd/system/cop-sdk-relay.service").write_text(unit)
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "enable", "--now", "cop-sdk-relay"], check=True)
    print("Serviço instalado. Confira: systemctl status cop-sdk-relay --no-pager")

if __name__ == "__main__":
    os.umask(0o077)
    main()
