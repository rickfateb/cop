# COP · Central de Operações Cobile

Portal inicial para configurar **unidades → DVRs Intelbras → câmeras → política de captura**. Cada câmera pode ser ativada separadamente, receber offsets de fotos após o início de movimento, intervalo mínimo entre eventos, duração mínima do movimento, política de encaminhamento para IA e retenção desejada.

## Estado atual

O portal cadastra e persiste configurações em PostgreSQL. **Ainda não se conecta aos DVRs, não captura fotos e não envia imagens à IA.** O amarelo na linha do tempo do aplicativo Intelbras não demonstra por si só que a interface de eventos está acessível pela rede nem que o snapshot funciona em cada firmware. Essas funções dependem de validação com um aparelho real e de um coletor com acesso à rede do DVR.

## Executar

Requer Node.js 20+ e PostgreSQL. Crie um banco separado para o COP ou use o PostgreSQL existente com as tabelas `cop_*`.

1. `npm install`
2. Configure `DATABASE_URL` e `COP_ADMIN_TOKEN` (token aleatório de pelo menos 24 caracteres) no ambiente; veja `.env.example`.
3. `npm start`
4. Acesse a URL do serviço e entre com `COP_ADMIN_TOKEN`.

O esquema é criado na inicialização (`src/schema.sql`). Em Railway, use a raiz do repositório, `npm install` no build e `npm start` na execução; configure também as variáveis acima. O serviço atende em `PORT`, padrão 3000. `/health` é um endpoint de disponibilidade sem informações sensíveis. Execute `npm test` e `npm run check` para validar o código.

O acesso administrativo usa uma única chave em memória na aba do navegador, enviada por HTTPS como Bearer. É adequado apenas para implantação inicial com poucos administradores; antes de abrir o portal para outros perfis, integrar à autenticação de Supervisor/Administrador do Cobile, com registros de auditoria. Nunca coloque a senha do DVR no cadastro: informe somente o **nome da variável de ambiente** que ficará no agente coletor. O campo `host` é endereço da rede privada e não deve apontar para uma porta de DVR exposta na internet.

## Políticas

| Campo | Função |
| --- | --- |
| Capturar | Seleciona o canal para eventos de movimento. |
| Segundos `0, 2, 5, 10` | Agenda até 10 fotos em até 300 s do início do evento. |
| Pausa entre eventos | Reduz eventos repetidos do mesmo canal. |
| Movimento mínimo | Ignora eventos mais curtos que o limite. |
| IA | Desligada, manual, em todo evento válido ou após uma duração. |
| Retenção | Prazo desejado das fotos; a exclusão efetiva será implementada junto ao armazenamento. |

Essas políticas são **configuração para o coletor futuro** e não alteram as configurações de movimento dentro dos DVRs.

## Próxima integração

1. Instalar um pequeno agente na rede de uma unidade, ou oferecer VPN privada, e testar um canal de cada geração de DVR. Verificar autenticação, eventos `VideoMotion`, canal, duração, reconexão e JPEG de `snapshot.cgi` com firmware real.
2. Enviar ao COP os eventos e as fotos em horários configurados; armazenar imagens em bucket privado S3 e metadados no PostgreSQL. Definir deduplicação, relógio, falhas de rede, retenção e limite de armazenamento.
3. Adicionar fila persistente e trabalhador externo (por exemplo, Hostinger) para analisar somente eventos selecionados. Restringir o acesso às imagens com URLs de curta duração e autenticar o retorno do resultado.
4. Exibir eventos e resultados na interface, com filtros por unidade, câmera e horário.

Referência técnica para avaliar, **sem pressupor compatibilidade com todo firmware**: [HTTP API Intelbras](https://botminio.apps.intelbras.com.br/sdk-api/HTTP%20API%20V3.35_Intelbras.pdf). O documento descreve `VideoMotion` e `snapshot.cgi`, mas o suporte concreto deve ser medido no aparelho de prova.
