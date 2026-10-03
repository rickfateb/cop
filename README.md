# COP · Central de Operações Cobile

Portal e receptor central para **unidades → DVRs Intelbras → câmeras → eventos por movimento**. A primeira integração operacional foi desenhada para os MHDX atuais sem agente local: o próprio DVR abre uma conexão de saída e envia as fotos para o COP por **SFTP**.

## Arquitetura operacional v0.2

```text
Câmeras -> DVR Intelbras -> Foto por DM -> SFTP/TCP Proxy Railway
                                         -> /<ingest_key>/...
                                         -> scanner COP
                                         -> PostgreSQL
                                         -> evento agrupado
                                         -> fila de análise por IA
```

Essa rota não exige IP público na loja, redirecionamento de porta ou computador local. O Intelbras Cloud/P2P permanece cadastrado como frente de homologação para live view, gravações e comandos remotos futuros.

## O que já funciona no código

- Cadastro de unidades, DVRs e câmeras.
- Modelos MHDX 1104, 1108, 3108 e 3116.
- Serial Intelbras Cloud armazenado como identificação.
- Modos SFTP, FTP, HTTP/RTSP direto e Intelbras Cloud.
- `ingest_key` exclusivo por DVR, usado no campo **Local** do FTP/SFTP Intelbras.
- Servidor OpenSSH/SFTP dentro do mesmo container do COP.
- Scanner de arquivos recebidos com espera por estabilidade do upload.
- SHA-256 e idempotência para evitar reprocessamento.
- Associação automática a DVR e tentativa conservadora de detectar o canal pelo caminho/nome.
- Agrupamento temporal de fotos em eventos.
- Mídia inicial armazenada em PostgreSQL (BYTEA) com retenção automática.
- Fila `cop_analysis_jobs` preparada para o trabalhador de IA.
- `/health` monitora web + scanner.

## Configuração do DVR Intelbras

Na interface do DVR, abra **Rede → FTP** e configure inicialmente somente fotos:

1. Habilite o serviço e selecione **SFTP**.
2. Use o domínio e a porta externa do TCP Proxy do COP.
3. Usuário: `cop_ingest` (ou `SFTP_USERNAME`).
4. Senha: `COP_SFTP_PASSWORD` configurada na Railway.
5. Campo **Local**: use o `ingest_key` exclusivo daquele DVR.
6. No piloto, habilite o período de 24 horas.
7. Em cada canal desejado, habilite **Foto + DM (Detecção de Movimento)**.
8. Em **Enviar Captura**, comece com intervalo de 5 s.
9. Não habilite vídeo no primeiro piloto.
10. Use o botão **Teste** do próprio DVR para validar servidor e credenciais.

O COP preserva o caminho recebido para aprendermos a estrutura real de pastas e nomes criada por cada firmware.

## Railway

O container escuta HTTP em `PORT` (padrão 3000) e SFTP em `SFTP_PORT` (padrão 2222). Exponha o HTTP normalmente e crie um TCP Proxy para a porta interna 2222.

Variáveis obrigatórias: `DATABASE_URL`, `COP_ADMIN_TOKEN` e `COP_SFTP_PASSWORD`.

A mídia fica inicialmente no PostgreSQL para acelerar a homologação. Depois de medir o volume real, os binários podem migrar para object storage sem alterar o modelo de eventos.

## Segurança

- Portal protegido por Bearer token e HTTPS.
- SFTP limitado por internal-sftp, chroot e sem shell/túnel.
- Cada DVR usa `ingest_key` próprio.
- Não exponha HTTP/37777/RTSP dos DVRs na internet para esta integração.

## Desenvolvimento

Requer Node.js 20+ e PostgreSQL.

```bash
npm ci
npm test
npm run check
npm start
```


## Revisão de comportamentos e roupas

Em **Resumos**, a seção de revisão apresenta as próximas análises com ações, canais, horários de gravação disponíveis e evidências. O filtro de roupas mostra candidatos com características de vestuário ou objetos semelhantes à referência, sem associação automática de identidade. Pagamento precisa de conciliação independente.

Em **Investigações**, o botão da ocorrência Cerejeiras prepara 02/10/2026, 19h10–19h16, com os canais ativos cadastrados no DVR da unidade. Confirme o relógio do DVR antes de criar a solicitação; o horário do formulário usa São Paulo. O conector de playback precisa estar conectado para recuperar os vídeos. Preparar a janela não baixa nem solicita gravações.

Alertas definitivos das ocorrências graves dependem de **Confirmar ocorrência para alerta**; **Descartar alerta** impede sua liberação. A confirmação mantém o envio no horário previamente configurado. O resultado de roupa sozinho nunca cria alerta grave. As APIs de revisão usam a autenticação administrativa existente.

## Captura por período

Em **Investigações → Captura por período**, informe unidade/DVR, data inicial e final
(no relógio de São Paulo), um ou mais canais, tipo **Modo Contínuo / Apenas movimento /
IA** e mídia **Foto / Vídeo / Todos**. O botão de Cerejeiras prepara canal 2, fotos por
movimento desde 10/09/2026; registrar continua sendo uma ação separada.

`POST /api/captures` aceita `unit_id`, `dvr_id`, `start_at`, `end_at` (RFC3339 com
fuso), `channels`, `capture_mode` (`continuous`, `motion`, `ai`) e `media_type`
(`photo`, `video`, `all`). `GET /api/captures` lista as solicitações e seus canais.
Ambas as rotas usam a autenticação administrativa e proteção de origem do portal.
Datas invertidas, canais inativos e DVR de outra unidade são recusados.
Os parâmetros de captura de cada câmera são copiados para a solicitação; alterações
posteriores no cadastro não mudam os intervalos registrados nessa solicitação.

IA significa eventos registrados pela IA do DVR, sem iniciar análise das mídias no
COP. Apenas movimento exige eventos detectados pelo DVR; não usa inferência visual
como substituição. Foto não baixa vídeos para extrair quadros. Todos exige ambas
as mídias, sem reduzir automaticamente o pedido a vídeo.

O receptor atual executa somente Modo Contínuo + Vídeo, período passado de até
120 minutos, em DVR com RTSP direto ou SDK Auto Registro configurado. Esses pedidos
criam uma investigação na mesma transação e acompanham seu status. Demais combinações
são salvas como **Aguardando conector**, com a limitação explicitada na tela. Ainda
não existe um consumidor para esses pedidos: sua execução exige atualização do
receptor para a mídia/evento/período solicitado. Nenhuma foto histórica, detecção de
movimento/IA ou busca de vários dias é anunciada como executada por esse formulário.
