# Piloto Auto Registro Intelbras — Cerejeiras

Receptor Linux x86_64 para homologar o acesso ao DVR MHDX 1104-C pela conexão de saída de Auto Registro. Recebe o registro, valida o identificador esperado, autentica com `CLIENT_LoginEx2`/`SERVER_CONN` e baixa um canal por intervalo com `CLIENT_DownloadByTimeEx`. Não usa login Intelbras Cloud nem porta local do SIM Next.

## Estado e limites

- Código compilado e seis cenários simulados passaram: sucesso, senha/login recusado, arquivo vazio, download incompleto, data inválida e intervalo longo.
- O cabeçalho 3.050 fornecido no pacote C++ foi usado para compilação e simulação; ele inclui tipos para Linux. A ABI deve ser validada com o cabeçalho/bibliotecas da distribuição Linux64 correspondente antes de instalar.
- Sem teste real no VPS/DVR. Sem promessa de compatibilidade com o firmware.
- Apenas piloto de um DVR, uma execução, um canal e até 120 segundos. Encerra depois do teste. Não é serviço permanente nem integra automaticamente a fila de investigações do COP.
- Este piloto aceita notificações `DH_DVR_SERIAL_RETURN` (1). Se o firmware usar apenas notificações binárias com token (2), será necessário implementar e homologar esse fluxo. Elas são ignoradas, sem interpretar dados binários como strings.
- Bibliotecas, cabeçalhos e executáveis do fabricante não são redistribuídos neste repositório.

## Pré-requisitos no VPS

1. Linux x86_64, compilador `g++`, bibliotecas Linux64 NetSDK 3.050 e seus arquivos de dependência. DLLs Windows não servem.
2. Extrair a distribuição autorizada Linux64 em uma pasta própria, por exemplo `/opt/intelbras-sdk`. Manter o cabeçalho original correspondente em `include/` e as bibliotecas na pasta indicada pela distribuição.
3. Confirmar no painel Hostinger o IPv4 público atual. Não usar `127.0.0.1` do navegador como destino do DVR.
4. Verificar se a porta escolhida está livre: `ss -ltnp`. Preparar a regra TCP de entrada dessa porta tanto no firewall do VPS quanto no painel Hostinger. Não abrir portas no roteador da loja para este piloto.
5. Executar como usuário sem privilégios administrativos, em diretório de gravação com acesso restrito. Não inserir a senha do DVR em argumentos, repositório ou logs.

O download automatizado da distribuição Linux foi bloqueado pelo Google Drive, que classificou o arquivo como malware/spam. As bibliotecas Linux não foram examinadas. Obter e validar a distribuição por um canal autorizado do fabricante antes de executá-la.

## Compilar

Na pasta deste piloto:

```sh
NETSDK_INCLUDE=/opt/intelbras-sdk/include sh build.sh
```

## Executar o teste

Usar inicialmente 30 segundos de um horário em que existe gravação. As datas são **o horário local exibido pelo DVR**, sem conversão para UTC. O número do canal é o exibido na interface (canal 1 vira índice SDK 0).

Exemplo com estrutura de bibliotecas `lib/` — ajustar ao caminho real da distribuição:

```sh
umask 077
LD_LIBRARY_PATH=/opt/intelbras-sdk/lib ./build/cop-autoregister-pilot \
  /opt/intelbras-sdk/lib/libdhnetsdk.so 0.0.0.0 8000 101 admin 1 \
  2026-09-30T10:41:38 2026-09-30T10:42:08 recordings/cerejeiras-ch1-teste.dav
```

A senha é solicitada pelo terminal com entrada oculta. A senha continua sendo necessária mesmo com registro ativo. O receptor aguarda até 180 segundos pelo registro e até 180 segundos pelo download. Manter o terminal aberto.

## Configuração de Cerejeiras

**Aplicar somente depois de o receptor mostrar `LISTENING` e a porta estar acessível externamente.**

| Campo em Rede → Auto Registro | Valor do piloto |
|---|---|
| Habilitar | Marcado |
| No. | 1 |
| Endereço do Servidor | IPv4 público atual e confirmado do VPS |
| Porta | 8000, se livre e liberada; caso contrário ajustar também o receptor |
| ID do Dispositivo Secundário | 101, reservado para Cerejeiras neste piloto |

`101` é um identificador proposto para o piloto, não o número de série do DVR. A correspondência entre esse campo e o identificador efetivamente enviado pelo firmware deve ser confirmada no teste. O receptor só autentica se receber o ID esperado. Se não houver registro válido, conferir conectividade e o identificador retornado com suporte/debug local; não desabilitar a validação para tentar logar em qualquer equipamento.

## Evidência esperada

1. `LISTENING`: processo conseguiu abrir a escuta local (não prova que o firewall externo permite entrada).
2. `REGISTERED`: callback compatível e ID esperado recebidos.
3. `AUTHENTICATED`: credenciais aceitas e canais reportados.
4. `DOWNLOAD_COMPLETE bytes=N`: SDK reportou conclusão e o arquivo é não vazio. Ainda verificar duração e reprodução com ferramenta apropriada, como FFprobe/FFmpeg ou player DAV.

Falhas retornam código diferente de zero. Arquivos não concluídos ficam com sufixo `.partial`; não são anunciados como gravação válida. O programa recusa sobrescrever saídas existentes.

Ao terminar, desmarcar Auto Registro no DVR e fechar a regra temporária de entrada até decidir a instalação permanente. O piloto não altera FTP/SFTP, Intelbras Cloud, agenda de gravação ou dados do portal.

## Testes simulados

```sh
NETSDK_INCLUDE=/opt/intelbras-sdk/include sh tests/run.sh
```

O simulador testa o fluxo de callbacks e o tratamento de erros; não faz conexão de rede, não emula o protocolo Intelbras e não prova o funcionamento de bibliotecas reais ou do equipamento.
