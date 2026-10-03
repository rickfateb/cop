#!/usr/bin/env python3
"""Update an installed relay without requesting or replacing its credentials."""
import json
import os
import pathlib
import shutil
import subprocess
import tempfile

def main():
    if os.geteuid()!=0:raise SystemExit('Execute como root no VPS.')
    root=pathlib.Path(__file__).resolve().parent
    if root.parent!=pathlib.Path('/opt/cop-sdk-pilot'):raise SystemExit('Checkout esperado: /opt/cop-sdk-pilot.')
    config_path=pathlib.Path('/etc/cop-sdk/config.json')
    if not config_path.is_file():raise SystemExit('Conector ainda não instalado. Use setup.py.')
    config=json.loads(config_path.read_text())
    target=root/'build/cop-sdk-receiver'
    if pathlib.Path(config['receiver']).resolve()!=target.resolve():raise SystemExit('O binário configurado está em outro diretório; revisar instalação.')
    include=pathlib.Path('/opt/intelbras-sdk/include')
    if not (include/'dhnetsdk.h').is_file():raise SystemExit('Header do SDK Linux não encontrado.')
    for program in ('g++','ffmpeg','ffprobe','systemctl'):
        if not shutil.which(program):raise SystemExit('Dependência ausente: '+program)
    # Compile before touching the running executable or restarting the service.
    target.parent.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='cop-update-',dir=target.parent) as temporary:
        binary=pathlib.Path(temporary)/'receiver'
        subprocess.run(['g++','-std=c++17','-Wall','-Wextra','-pthread','-I',str(include),str(root/'receiver.cpp'),'-ldl','-o',str(binary)],check=True)
        subprocess.run(['python3','-m','py_compile',str(root/'relay.py'),str(root/'historical.py')],check=True)
        os.chmod(binary,0o755)
        backup=target.with_suffix('.previous')
        if target.exists():shutil.copy2(target,backup)
        subprocess.run(['systemctl','stop','cop-sdk-relay'],check=True)
        os.replace(binary,target)
        subprocess.run(['systemctl','start','cop-sdk-relay'],check=True)
        subprocess.run(['systemctl','is-active','--quiet','cop-sdk-relay'],check=True)
    print('Receptor atualizado. Credenciais, porta e diretório preservados.')
    print('Homologação pendente: verificar conexão do DVR e testar uma captura curta de movimento/foto.')

if __name__=='__main__':
    os.umask(0o077)
    main()
