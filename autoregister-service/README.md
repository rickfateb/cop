# Auto Registro permanente — COP

Homologação inicial: Cerejeiras, MHDX 1104-C, Ubuntu 24.04 x86_64, NetSDK Linux64
3.050.0000005.4.R.190306. O piloto autenticou quatro canais e recuperou Canal 1:
30 segundos, 900 quadros, H.265, 960×1080. O DAV inteiro decodificou sem erros.
Isso não homologa automaticamente outros modelos/firmwares nem estabilidade de longa duração.

## Fluxo

O DVR abre a conexão para TCP 8000 no VPS. O receptor aceita somente os IDs
configurados, autentica com SERVER_CONN e mantém a sessão aberta. Uma desconexão
invalida a sessão; o próximo registro permite uma nova autenticação.
Notificações binárias com token (evento 2) continuam fora do escopo; evento 1 é
o fluxo homologado em Cerejeiras. O ID não substitui autenticação por senha.

O relay consulta a fila do COP por HTTPS, usando token exclusivo de conector.
Cada canal recebe uma reserva de 10 minutos, renovada a cada 30 segundos.
Reinícios ou reservas vencidas permitem nova tentativa; três falhas encerram o
canal como falha, com os canais prontos preservados. O portal aceita reenvio da
mesma conclusão sem criar mídia duplicada e rejeita conclusões de reservas antigas.

Janelas de até 120 minutos são divididas em partes úteis de até 116 segundos,
com margem de dois segundos em cada lado. A margem permanece dentro do limite
de 120 segundos por chamada SDK. Os timestamps DAV orientam o corte de cada
parte, em vez de presumir diferença fixa de um segundo. Resultados sem cobertura
temporal suficiente são recusados. O vídeo é convertido em H.264/MP4 sem áudio,
validado e enviado à investigação. Limite: 256 MiB por canal. O COP conserva a
mídia por 15 dias; fragmentos locais são removidos após cada tarefa e no reinício.

## Instalar no VPS existente

Não há SDK proprietário, senhas nem executáveis do fabricante neste repositório.
Use o pacote autorizado já extraído em /opt/intelbras-sdk, com include/ e bin/.
Pare o piloto de uma execução antes de ocupar a mesma porta com o serviço.

1. Publique o código do portal e configure COP_SDK_CONNECTOR_TOKEN na Railway:
   token aleatório com pelo menos 32 caracteres. Ele autoriza somente as rotas SDK.
2. Atualize o checkout /opt/cop-sdk-pilot para a versão aprovada.
3. Instale dependências e execute o instalador interativo:

```sh
apt-get install -y g++ python3 ffmpeg
python3 /opt/cop-sdk-pilot/autoregister-service/setup.py
systemctl status cop-sdk-relay --no-pager
journalctl -u cop-sdk-relay -n 30 --no-pager
```

O instalador pede token do conector, ID 101, usuário admin e senha do DVR.
Senhas são lidas com entrada oculta, sem argumentos de processo. Configuração:
/etc/cop-sdk/config.json, root:cop-pilot, 0640; pasta 0750. A sessão SDK roda
como cop-pilot, sem login de shell. O serviço reinicia automaticamente e inicia
com o Ubuntu. Não reinicie o VPS só para instalar.

No painel Hostinger, confirme a entrada TCP 8000 se um firewall estiver associado.
No DVR, mantenha Auto Registro em 2.25.64.178:8000, ID 101 somente enquanto esse
IP continuar sendo o IPv4 público confirmado do VPS.

No COP, editar DVR Cerejeiras:
- Recuperação de gravações: SDK · Auto Registro.
- ID de Auto Registro: 101.
- Receptor de gravações: hostinger.

O campo de status fica conectado somente com autenticação SDK e heartbeat recente.
Crie inicialmente investigação manual curta, Canal 1. Verifique o MP4 pelo botão
Assistir antes de homologar os demais canais e ampliar as janelas.

## Operação

```sh
systemctl restart cop-sdk-relay
journalctl -u cop-sdk-relay -f
```

Para incluir outro DVR, adicione um objeto em devices na configuração protegida,
com ID único, username e password; registre o mesmo ID no portal e reinicie o
serviço. IDs desconhecidos não são autenticados. Todos os canais são processados
em série para limitar carga no KVM1. Não há disparo financeiro nem análise IA
automática nesta implementação; a investigação manual/API já pode solicitar a busca.

Reversão: systemctl disable --now cop-sdk-relay; no COP selecionar recuperação
Não configurada; desabilitar Auto Registro no DVR e fechar a regra TCP temporária.
As gravações originais do HD e arquivos já recebidos permanecem preservados.

## Validação

```sh
NETSDK_INCLUDE=/opt/intelbras-sdk/include sh autoregister-service/test/run.sh
npm test
npm run check
```

Os testes nativos usam biblioteca simulada: sessões persistentes, dois downloads,
desconexão/nova autenticação, vazio e recusa de sobrescrita. Não simulam protocolo
de rede. A conversão com timestamps foi testada com DAV real do piloto.
O CI usa PostgreSQL temporário para testar migração repetida, reservas concorrentes,
expiração, conclusão idempotente, tentativas e cancelamento. O SDK do fabricante
não é exigido nos testes públicos do CI.
