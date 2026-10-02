# Arquivamento COP no Google Drive

Pasta permanente configurada: COP, ID 10TAZd6XsPTtno1RDk5gQuKKKfZI8OwpJ.

## Regras
- Worker no próprio COP, a cada minuto, inicia novos arquivos somente entre 01:00 e 06:00 America/Sao_Paulo. Um envio iniciado pode terminar depois das 06h.
- Seleciona arquivos recebidos antes do dia atual, incluindo backlog e gravações retroativas. Tentativas com erro voltam à fila após 15 minutos.
- COP / Ano / Mês em português / Nome do DVR / Dia com dois dígitos.
- A data de gravação vem do início solicitado na investigação ou de timestamp reconhecido no caminho original enviado pelo DVR. Frames usam o deslocamento do frame. Se desconhecida, bloqueia o arquivamento e a liberação local; não presume data de recebimento.
- Vídeo que cruza meia-noite usa a data inicial. IDs prefixados nos nomes de arquivos evitam colisões entre câmeras.
- O ID Drive é gerado e salvo antes de enviar. Retry verifica esse mesmo ID, inclusive após interrupção entre upload e confirmação PostgreSQL.
- Cópia conferida por tamanho e MD5 remoto, SHA-256 local e pasta de destino. Sem conferência, não libera bytes locais.
- 15 dias após RECEBIMENTO: reconfere a cópia remota e limpa apenas o payload BYTEA. Preserva metadados, IDs, investigações e referências de evidências. Jobs IA pendentes/em execução impedem liberação.
- Reprodução autenticada após liberação recupera os bytes do Drive no backend e verifica SHA-256. Nenhuma pasta é tornada pública.
- Não há exclusão no Drive. Pasta raiz deve ser COP; duplicidade de pastas iguais exige revisão.
- Liberação de BYTEA permite reutilizar espaço PostgreSQL após vacuum; não garante redução imediata do volume físico ou da fatura Railway.

## Autorização necessária para ativação
O conector Drive do ChatGPT NÃO disponibiliza seu token ao serviço Railway.
O login Google do COP só autentica identidade; não autoriza upload ao Drive.
São necessárias variáveis privadas Railway:
- COP_DRIVE_CLIENT_ID: OAuth web client ID.
- COP_DRIVE_CLIENT_SECRET: segredo desse cliente.
- COP_DRIVE_REFRESH_TOKEN: refresh token com autorização offline da conta dona da pasta.
- COP_DRIVE_ROOT_ID: 10TAZd6XsPTtno1RDk5gQuKKKfZI8OwpJ.

Ative Google Drive API no projeto Google Cloud. Para obter o refresh token,
use o OAuth 2.0 Playground oficial https://developers.google.com/oauthplayground
com credenciais próprias (engrenagem: Use your own OAuth credentials).
Adicione https://developers.google.com/oauthplayground aos redirects autorizados
do cliente usado (preserve os redirects e origens existentes).
Autorize https://www.googleapis.com/auth/drive na conta proprietária. O escopo
completo é necessário para reutilizar a pasta criada por outro aplicativo
(o conector ChatGPT); drive.file isolado não garante acesso a essa pasta.
Configure access_type=offline e prompt=consent; troque authorization code por tokens.
Guarde client secret e refresh token diretamente nas variáveis Railway, nunca
em commit, print ou conversa. Em aplicativo External/Testing, refresh tokens
com Drive podem expirar em 7 dias; configure produção para uso contínuo conforme
regras Google aplicáveis. Não reutilize token OAuth pertencente ao conector ChatGPT.

Após configurar, redeploy e confira Arquivo / Drive > Integração configurada.
Na primeira madrugada, confirme contadores e arquivos reais antes de considerar
homologada a integração. Erros de permissões/pasta/API deixam originais preservados.

Referências oficiais:
https://developers.google.com/identity/protocols/oauth2/web-server
https://developers.google.com/workspace/drive/api/guides/manage-uploads
https://developers.google.com/workspace/drive/api/reference/rest/v3/files/generateIds
