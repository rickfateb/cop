# COP FTP Gateway

Gateway para DVRs Intelbras que não conseguem concluir o envio pelo SFTP/OpenSSH.

Fluxo: MHDX -> FTP/PASV na VPS -> gateway -> HTTPS autenticado -> COP.

## Portas da VPS

- TCP 21
- TCP 21000-21010 (modo passivo)

Essas portas precisam estar liberadas no firewall/security group da VPS.

## Variáveis

- FTP_PUBLIC_IP: IP público fixo da VPS
- FTP_USER: padrão cop_ftp
- FTP_PASSWORD: senha usada no DVR
- FTP_ROOT: padrão /srv/ftp
- FTP_PASV_MIN_PORT: padrão 21000
- FTP_PASV_MAX_PORT: padrão 21010
- FTP_INGEST_KEYS: lista separada por vírgula; para Cerejeiras use d71e617fa7a5
- COP_BASE_URL: URL HTTPS do COP
- COP_GATEWAY_TOKEN: segredo compartilhado com COP_GATEWAY_TOKEN na Railway

## Docker

Exemplo:

```bash
docker build -t cop-ftp-gateway ./ftp-gateway
docker run -d --name cop-ftp-gateway --restart unless-stopped \
  -p 21:21 -p 21000-21010:21000-21010 \
  -e FTP_PUBLIC_IP=SEU_IP_PUBLICO \
  -e FTP_PASSWORD='SENHA_FORTE' \
  -e FTP_INGEST_KEYS='d71e617fa7a5' \
  -e COP_BASE_URL='https://cop-web-ingest-production.up.railway.app' \
  -e COP_GATEWAY_TOKEN='SEGREDO_COMPARTILHADO' \
  cop-ftp-gateway
```

## Intelbras Cerejeiras

No DVR selecione FTP (não SFTP), servidor = IP público da VPS, porta = 21, usuário = cop_ftp, senha = FTP_PASSWORD, Local = d71e617fa7a5.
