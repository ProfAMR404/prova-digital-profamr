# Mapa de exportação para o RMCr [Fase 6]

O botão Exportar para o RMCr gera um JSON alinhado ao schema `casos.*` do RMCr,
sem escrever no banco. A ingestão no destino é feita pelo RMCr, com as devidas
checagens de RLS e vínculos. Nenhum dado sai da máquina pela exportação em si.

## Fonte verificada

Projeto Supabase `rmcr-penal` [ref `rrjnnoxpkwpioasmecax`]. Colunas conferidas
nas migrations do repo `ProfAMR404/rmcr-penal`:

- `supabase/migrations/0028_casos_processo_parte_imputacao.sql` [casos.processo, casos.parte, casos.imputacao]
- `supabase/migrations/0033_casos_prova_custodia.sql` [casos.prova, casos.cadeia_custodia]
- `supabase/migrations/0027_casos_schema_enums.sql` [casos.classe_processual, casos.fase_processual]

## Mapa de campos

### processo [casos.processo]

| JSON exportado | Coluna RMCr | Origem no app |
|---|---|---|
| numero_cnj | numero_cnj | Ficha, Autos n. |
| orgao_julgador | orgao_julgador | Ficha, Vara / Órgão |
| classe_processual | classe_processual [enum] | Ficha, Classe, por palavra-chave |
| classe_texto | — | Classe, texto cru, quando o enum não casa |
| fase_processual | fase_processual [enum] | Ficha, Etapa, por palavra-chave |
| fase_texto | — | Etapa, texto cru |
| titulo | titulo | Classe ou Arguido |
| sinopse | sinopse | Hipótese acusatória [HAc] |
| observacoes | observacoes | HDef e Imputação, texto |
| data_fato | data_fato | Ficha, Data |

### partes [casos.parte]

Uma parte com `nome` [Arguido] e `papel` arguido. O vínculo a `tipo_penal` e a
`usuario` do destino não é fabricado aqui; a imputação vai como texto em
`processo.observacoes`.

### provas [casos.prova], uma por laudo

| JSON exportado | Coluna RMCr | Origem no app |
|---|---|---|
| titulo | titulo | Nome do laudo |
| fonte | fonte | Fixo, laudo pericial |
| autoridade_produtora | autoridade_produtora | Perito do caso ou da identificação |
| digital_dispositivo | digital_dispositivo | IMEI ou número de série |
| digital_serial | digital_serial | Número de série |
| conclusao | conclusao | Título do veredito |
| custodia_iniciada | custodia_iniciada | Fixo, true |
| admissibilidade | admissibilidade [enum] | Veredito, ver tabela abaixo |
| fundamento_inadmissibilidade | fundamento_inadmissibilidade | Corpo do veredito em inexistência e quebra |
| notas | notas | hash, lacre, conta, provedor, ordem judicial |

### Veredito para admissibilidade

| Escala do gabinete | admissibilidade [enum RMCr] |
|---|---|
| Inexistência | inadmitida_ilegitima |
| Quebra | imprestavel |
| Arranhão | admitida |
| Conformidade plena | admitida |
| Provisório / sem tipo | null |

## Fora do mapa

`casos.cadeia_custodia` espera uma sequência de eventos com hash encadeado. O app
afere a conformidade por itens, não registra a linha do tempo de eventos, então a
exportação não preenche `cadeia_custodia`. O preenchimento fica para o RMCr, a
partir dos dados do processo.
