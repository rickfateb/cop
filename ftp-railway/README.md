# COP FTP Railway Gateway

Servidor FTP mínimo para o piloto Intelbras MHDX, projetado para Railway.

- controle interno: 2121
- dados PASV internos: 21000
- a porta PASV pública é fornecida por um serviço relay separado e configurada em FTP_PUBLIC_DATA_HOST/FTP_PUBLIC_DATA_PORT.
- após receber arquivo, encaminha por HTTPS para o COP e remove a cópia local após confirmação.
