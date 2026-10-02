# Login Google do COP

A tela principal usa Google Identity Services. O backend verifica assinatura RSA,
audience, issuer, expiração, e-mail verificado e nonce de uso único. Somente e-mails
em COP_GOOGLE_ALLOWED_EMAILS podem acessar; o perfil inicial é administrador.
A identidade usa o identificador Google sub. A sessão fica em cookie HttpOnly,
Secure, SameSite=Strict, restrito a cop.cobile.com.br, com validade de 30 dias.
O banco guarda somente o hash do token da sessão. Sair revoga a sessão no banco.
Mudanças administrativas feitas por cookie exigem a origem do COP.

Variáveis Railway:
- GOOGLE_CLIENT_ID: identificador público do cliente web usado pelo Cobile.
- COP_GOOGLE_ALLOWED_EMAILS: e-mails administrativos, separados por vírgula.
- COP_PUBLIC_BASE_URL: https://cop.cobile.com.br.

No Google Cloud Console > Google Auth Platform > Clients, editar o cliente Web
usado pelo Cobile e adicionar https://cop.cobile.com.br às origens JavaScript
autorizadas. Não substitua as origens já cadastradas. O botão usa popup/callback
JavaScript; não precisa de client secret ou URI de redirecionamento neste fluxo.

Os tokens COP_ADMIN_TOKEN (integrações existentes) e COP_SDK_CONNECTOR_TOKEN
(receptor de gravações) continuam independentes; não são usados pelo navegador.
O novo login não exige alteração na VPS nem reinício do receptor instalado.
Testes de autenticação verificam rejeição de credenciais adulteradas, conta não
autorizada, origem externa, nonce reutilizado, sessão persistente e revogação.
O consentimento e login reais dependem de configuração da origem no Google.
