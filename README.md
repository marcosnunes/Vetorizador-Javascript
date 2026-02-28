# Ferramenta Vetorizadora + PDFSpliter com PDFtoArcGIS

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform](https://img.shields.io/badge/platform-Desktop%20App-brightgreen.svg)
![WebAssembly](https://img.shields.io/badge/WebAssembly-Rust-orange.svg)
![Status](https://img.shields.io/badge/status-Active-green.svg)

Solução corporativa integrada que consolida, em um único aplicativo, a **Ferramenta Vetorizadora de Edificações** e o **PDFSpliter**, com o módulo **PDFtoArcGIS** como elo estratégico entre documentação técnica e inteligência territorial.

---

## Visão Geral

O aplicativo é estruturado em dois blocos de alto impacto operacional:

- **Vetorizador de Edificações**: acelera levantamentos geoespaciais com padrão e rastreabilidade.
- **PDFSpliter**: padroniza e automatiza o ciclo documental, da organização à extração de informações geográficas.

A proposta é centralizar fluxos críticos em um ambiente único, elevando produtividade, governança e previsibilidade operacional.

### Posicionamento para Apresentação Organizacional

- **Pilar 1 — Vetorizador**: maior velocidade e consistência na produção de dados territoriais.
- **Pilar 2 — PDFSpliter**: redução de esforço manual e padronização documental em escala.
- **Destaque Estratégico — PDFtoArcGIS**: converte documentos em informação geoespacial acionável para decisão.

### Resumo Executivo (30 segundos)

Esta solução integra, em uma única plataforma, duas frentes essenciais da operação: a **Vetorização de Edificações** e o **PDFSpliter**. Com o **PDFtoArcGIS**, documentos técnicos deixam de ser passivo operacional e passam a gerar dados geoespaciais utilizáveis em planejamento, fiscalização e gestão. O ganho direto para a organização é aumento de produtividade, padronização de processos, redução de retrabalho e maior segurança na tomada de decisão.

---

## Módulos do Aplicativo

### Vetorizador de Edificações

- Produção acelerada de dados territoriais com padrão técnico.
- Controle de qualidade automatizado com apoio à validação humana.
- Geração de entregáveis geoespaciais para integração com SIG.
- Rastreabilidade do processo de análise e revisão.

### Processador de PDF

- **Organização Documental**: divisão e consolidação de arquivos com rapidez e padronização.
- **Conversões Operacionais**: fluxos PDF↔imagem para demandas administrativas e técnicas.
- **PDFtoArcGIS**: transformação de conteúdo técnico em dados geográficos prontos para uso institucional.

### Diretriz de Arquitetura para PDFtoArcGIS (Azure AI)

- A leitura de PDF e extração de coordenadas será centralizada em **backend Azure**, com IA responsável por interpretar padrões documentais e geográficos.
- O cliente envia o PDF e recebe como resposta **apenas GeoJSON limpo** no formato de integração do fluxo interno.
- Não haverá fallback local por regex nem segunda rota de extração no front-end; em caso de falha, o backend retorna mensagem de erro estruturada.
- Esta decisão atende ao ambiente corporativo com restrições de firewall, priorizando serviços Microsoft já liberados.
- A adoção de Azure reforça requisitos institucionais de proteção de dados e governança operacional.

### Contrato da API (PDFtoArcGIS)

- Endpoint: `POST /pdfspliter/api/pdf-to-geojson`
- Entrada:
  - `pdfBase64` (string, obrigatório): conteúdo do PDF em Base64.
  - `fileName` (string, opcional): nome do arquivo para rastreabilidade.
- Saída de sucesso (`200`):
  - `success: true`
  - `matricula: string`
  - `projectionKey: string` (ex.: `SIRGAS2000_22S`)
  - `warnings: string[]`
  - `geojson: FeatureCollection` (1 polígono pronto para o fluxo)
  - `pagesAnalyzed: number`
- Saída de falha (`4xx/5xx`):
  - `success: false`
  - `error: string`
  - Sem fallback local automático no cliente.

### Variáveis de Ambiente (Azure)

- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_DEPLOYMENT`
- `AZURE_OPENAI_API_VERSION` (sugestão: `2024-10-21`)
- `AZURE_DOCUMENTINTELLIGENCE_ENDPOINT`
- `AZURE_DOCUMENTINTELLIGENCE_KEY`
- `AZURE_DOCUMENTINTELLIGENCE_API_VERSION` (sugestão: `2024-11-30`)

### Modelo recomendado (custo x qualidade)

- Padrão inicial: `gpt-4o-mini` (melhor equilíbrio para extração estruturada com custo menor).
- Upgrade seletivo: `gpt-4.1` para documentos de baixa qualidade/OCR difícil.

---

## Recursos-Chave

### Eficiência Operacional e Escala

- Redução de tempo de ciclo em atividades de vetorização e tratamento documental.
- Maior capacidade de atendimento sem aumento proporcional de estrutura.
- Continuidade operacional mesmo em cenários de conectividade limitada.

### Qualidade, Padronização e Confiabilidade

- Critérios objetivos de qualidade para reduzir inconsistências e retrabalho.
- Entregáveis padronizados para consumo institucional e auditoria técnica.
- Maior confiabilidade dos dados para planejamento e decisões executivas.

### Governança de Melhoria Contínua

- Processo estruturado de feedback para evolução controlada da operação.
- Acúmulo de histórico para gestão de desempenho e aprendizado organizacional.
- Base de dados preparada para ciclos de aprimoramento e inovação.

### Integração e Aproveitamento do Ecossistema Atual

- Compatibilidade com ferramentas GIS já adotadas pela organização.
- Integração do fluxo documental com o fluxo geoespacial em uma única jornada.
- Menor fricção de adoção pelas equipes e maior reaproveitamento de ativos existentes.

---

## Fluxo Operacional

### 1) Vetorização

1. Selecione a área de interesse no mapa.
2. Execute a vetorização automática.
3. Revise os polígonos por score e qualidade.
4. Ajuste/valide quando necessário.
5. Exporte os resultados geoespaciais.

### 2) Processamento de PDF

1. Escolha o módulo (Dividir, Unir, converter etc.).
2. Carregue os documentos.
3. Execute o processamento.
4. Baixe os arquivos gerados.

---

## Estrutura Funcional do Projeto

```text
.
├── app.js
├── index.html
├── style.css
├── auto-inference.js
├── continuous-learning.js
├── ml-training.js
├── firebase-config.js
├── firestore-service.js
├── offline-queue.js
├── vetoriza/
│   ├── src/
│   └── pkg/
└── pdfspliter/
    ├── Dividir/
    ├── DividirApenas/
    ├── UnirPDF/
    ├── PDFtoJPG/
    ├── JPGtoPDF/
    ├── PDFtoArcgis/
    └── index.html
```

---

## Segurança e Privacidade

- Processamento de arquivos e imagens realizado localmente.
- Sem dependência obrigatória de upload para processamento básico.
- Camadas de armazenamento e sincronização quando aplicável.
- No módulo PDFtoArcGIS, o processamento evolui para backend Azure com contrato de retorno estrito em GeoJSON.
- Em falhas, o retorno esperado é mensagem de erro do serviço (sem fluxo alternativo de parsing no cliente).

---

## Casos de Uso

- Cadastro e atualização de base imobiliária.
- Auditoria e análise patrimonial.
- Preparação de dados para SIG corporativo.
- Fluxos documentais com divisão, fusão e conversão de PDFs.
- Extração geoespacial de documentos técnicos.

---

## Roadmap

- Evolução da inferência automática no vetorizador.
- Melhoria contínua da validação geoespacial no PDF para ArcGIS.
- Expansão de métricas e observabilidade operacional.

---

## Suporte

- [GitHub Issues](https://github.com/marcosnunes/Vetorizador-Javascript/issues)

---

## Contato

- Email: [marcos.nunes.lph@outlook.com](mailto:marcos.nunes.lph@outlook.com)
- Telefone: 41 9 98530 7378
- LinkedIn: [www.linkedin.com/in/marcos-nunes-lph](https://www.linkedin.com/in/marcos-nunes-lph)

---

## Licença

MIT

---

Desenvolvido por Marcos Roberto Nunes Lindolpho © 2026
