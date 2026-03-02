/* Funções para controlar o Menu Lateral (Sidenav) */
function openNav() {
    document.getElementById("mySidenav").style.width = "250px";
}

function closeNav() {
    document.getElementById("mySidenav").style.width = "0";
}

// Carrega o jsPDF, pdf.js e pdf-lib de forma assíncrona
let jsPDF; // Variável global para jsPDF (mantido, pode ser útil)
let Tesseract; // Variável global para Tesseract
let pdfjsLib; // Variável global para pdf.js
let PDFLib; // Variável global para pdf-lib

// Função para rolar a página para baixo suavemente
function scrollToPdfPagesContainer() {
    const pdfPagesContainer = document.getElementById("pdf-pages-container");
    if (pdfPagesContainer) {
        const headerElement = pdfPagesContainer.previousElementSibling; // H2 "Páginas Processadas"
        const elementToScrollTo = headerElement || pdfPagesContainer;
        elementToScrollTo.scrollIntoView({
            behavior: "smooth",
            block: "start"
        });
    }
}

// Função para carregar scripts dinamicamente
function loadScript(url, callback, id = null) {
    if (id && document.getElementById(id)) {
        if (callback) callback();
        return;
    }
    const script = document.createElement("script");
    if (id) script.id = id;
    script.type = "text/javascript";
    script.src = url;
    script.onload = callback;
    script.onerror = () => {
        console.error(`Erro ao carregar o script: ${url}`);
        displayLogMessage(`Erro ao carregar biblioteca essencial: ${url}. Recarregue a página.`);
        const processButton = document.getElementById("processarPDF");
        if (processButton) processButton.disabled = true;
    };
    document.head.appendChild(script);
}

// Função para exibir mensagens de log na interface e no console
function displayLogMessage(message) {
    const logMessages = document.getElementById("log-messages");
    if (logMessages) {
        logMessages.textContent = message;
    }
    console.log("Log:", message);
}

// Função assíncrona para ler arquivo como ArrayBuffer
function readFileAsync(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => resolve(event.target.result);
        reader.onerror = (event) => reject(new Error(`Erro ao ler o arquivo: ${event.target.error}`));
        reader.readAsArrayBuffer(file);
    });
}

// Função para atualizar o nome do arquivo selecionado na UI
function updateFileName() {
    const fileInput = document.getElementById("pdfUpload");
    const fileSelectedName = document.getElementById("file-selected-name");
    const pdfPagesContainer = document.getElementById("pdf-pages-container");
    const logMessages = document.getElementById("log-messages");
    const processButton = document.getElementById("processarPDF"); // Pegar botão para checar estado

    if (fileInput.files.length > 0) {
        fileSelectedName.textContent = "Arquivo selecionado: " + fileInput.files[0].name;
    } else {
        fileSelectedName.textContent = "Nenhum arquivo selecionado";
    }
    // Limpa resultados anteriores ao selecionar novo arquivo
    if (pdfPagesContainer) pdfPagesContainer.innerHTML = "";

    // Atualiza mensagem de log baseado no estado das libs e do botão
    if (Tesseract && pdfjsLib && PDFLib && processButton && !processButton.disabled) {
        displayLogMessage("Pronto para processar. Selecione um PDF.");
    } else if (!Tesseract || !pdfjsLib || !PDFLib) {
        displayLogMessage("Carregando bibliotecas, aguarde...");
    } else {
        displayLogMessage("Inicializando...");
    }
};

/**
 * Extrai informações de nome de um bloco de texto, com foco aprimorado
 * em layouts de Informe de Rendimentos PF e PJ.
 * @param {string} textToSearch O texto completo extraído da página.
 * @param {number} pageNumber O número da página (para logging).
 * @param {boolean} isOcr Indica se o texto veio do OCR.
 * @returns {{nome: string|null}} Objeto contendo o nome encontrado ou null.
 */
function extractNameInfo(textToSearch, pageNumber, isOcr = false) {
    if (!textToSearch) return { nome: null };
    console.log(`[Pág ${pageNumber}] Iniciando extração (${isOcr ? 'OCR' : 'Texto Direto'}).`);

    const lines = textToSearch.split('\n');
    let bestMatchInfo = { name: null, priority: 10, label: "" }; // Lower number = higher priority

    // --- Regex Patterns (Ajustados e Reorganizados por Prioridade) ---
    const captureNamePatternStrict = `([A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ\\s'.\\-]+[A-ZÀ-ÖØ-Þ])`; // Nome de pessoa (mais estrito)
    const captureNamePatternAny = `(.+)`; // Captura mais genérica, depende da validação
    const cnpjCpfPatternOnly = /(?:\d{2}[\.\s]?\d{3}[\.\s]?\d{3}[\/\s]?\d{4}[-\s]?\d{2}|\d{3}[\.\s]?\d{3}[\.\s]?\d{3}[-\s]?\d{2})/;

    // == PRIORIDADE 1: Labels mais diretos e confiáveis (PF) ==
    const nomeCompletoLabelsPF = `(?:Nome\\s*Completo)`;
    const labelNomeCompletoLineEndPF = new RegExp(`^${nomeCompletoLabelsPF}\\s*[:\\-]?\\s*$`, 'i');
    const labelNomeCompletoSameLinePF = new RegExp(`^${nomeCompletoLabelsPF}\\s*[:\\-]?\\s+${captureNamePatternStrict}`, 'i');
    const labelNomeBeneficiarioPF = /(?:2\.\s*Pessoa F[íi]sica Benefici[áa]ria dos Rendimentos.*?Nome Completo\s*[:\-]?\s*$(?:\r?\n){1,2}(.+))/is; // Tenta capturar contexto PF e nome na linha seguinte

    // == PRIORIDADE 2: Labels comuns de PJ (Beneficiária e Fornecedora) ==
    const nomeEmpresarialLabel = `(?:Nome\\s*Empresarial)`;
    const labelNomeEmpresarialSameLine = new RegExp(`^${nomeEmpresarialLabel}\\s*[:\\-]?\\s+${captureNamePatternAny}`, 'i');
    const labelNomeEmpresarialLineEnd = new RegExp(`^${nomeEmpresarialLabel}\\s*[:\\-]?\\s*$`, 'i'); // Nome na próxima linha
    const labelRazaoSocialAnyLine = /(?:RAZ[ÃA]O\s*SOCIAL)\s*[:\-]?\s*(.+)/i;
    const labelNomeCompletoFornecedorSameLine = /^Nome completo\s*[:\-]?\s+(.+)/i; // Simples, para seção Fornecedor
    const labelNomeCompletoFornecedorContext = /PESSOA JUR[ÍI]DICA FORNECEDORA DO SERVI[ÇC]O.*?Nome completo\s*[:\-]?\s*$(?:\r?\n){1,2}(.+)/is; // Tenta contexto Fornecedor e nome na linha seguinte

    // == PRIORIDADE 3: Outros labels e Contextos ==
    const otherBeneficiaryLabels = `(?:Benefici[áa]rio\\s*dos\\s*Rendimentos|Pessoa\\s*F[íi]sica\\s*Benefici[áa]ria|Benefici[áa]rio)`; // Outros labels de beneficiário
    const labelOtherBeneficiarySameLine = new RegExp(`^${otherBeneficiaryLabels}\\s*[:\\-]?\\s+${captureNamePatternAny}`, 'i'); // Usar validação para PF/PJ
    const labelOtherBeneficiaryLineEnd = new RegExp(`^${otherBeneficiaryLabels}\\s*[:\\-]?\\s*$`, 'i');
    const labelPrestadorAnyLine = /(?:PRESTADOR\s*DE\s*SERVI(?:ÇO|ÇOS)|PRESTADOR)\s*[:\-]?\s*(.+)/i;

    // == PRIORIDADE 4: Contexto CNPJ/CPF e Fonte Pagadora ==
    const nameAfterCnpjCpf = new RegExp(`${cnpjCpfPatternOnly.source}\\s*[-–—-]?\\s*${captureNamePatternAny}`, 'i'); // Captura genérica após CPF/CNPJ
    const labelFontePagadoraAnyLine = /(?:Fonte\\s*Pagadora|Nome\\s*da\\s*Empresa)\s*[:\\-]?\s*(.+)/i; // Nome Empresarial já está na prio 2


    // Ordem de aplicação reflete a prioridade
    // Combina testes multi-linha que usam textToSearch completo
     const fullTextPatterns = [
        { regex: labelNomeBeneficiarioPF, type: 'person', priority: 1, label: "Nome Completo PF (Contexto+Próxima Linha)" },
        { regex: labelNomeCompletoFornecedorContext, type: 'organization', priority: 2, label: "Nome Completo Fornecedor (Contexto+Próxima Linha)" },
    ];

     for (const pattern of fullTextPatterns) {
        if (pattern.priority >= bestMatchInfo.priority) continue;
        const matchResult = textToSearch.match(pattern.regex);
         if (matchResult && matchResult[1]) {
            const potentialName = matchResult[1].split('\n')[0].trim(); // Pega a primeira linha após o label
            console.log(`[Pág ${pageNumber}] DEBUG: Match FullText candidato via '${pattern.label}': "${potentialName}"`);
            const finalCleanedName = potentialName.replace(/^[\s\-.:]+|[\s\-.:]+$/g, '').replace(/\.{2,}/g, '.').trim();
            if (finalCleanedName && isValidName(finalCleanedName, pattern.type === 'organization', pattern.label)) {
                 if (pattern.priority < bestMatchInfo.priority) {
                    bestMatchInfo = { name: finalCleanedName, priority: pattern.priority, label: pattern.label };
                    console.log(`[Pág ${pageNumber}] >>> Match FullText VÁLIDO e MELHOR! Atualizado: "${bestMatchInfo.name}" [Pri: ${bestMatchInfo.priority}, Label: ${bestMatchInfo.label}, Tipo: ${pattern.type}] <<<`);
                }
            } else if (finalCleanedName) {
                 console.log(`[Pág ${pageNumber}] Match FullText INVÁLIDO via '${pattern.label}': "${finalCleanedName}"`);
            }
        }
    }


    // Processamento linha a linha (prioridade de acordo com a ordem)
    const linePatterns = [
        // Prioridade 1 (PF Foco)
        { regex: labelNomeCompletoLineEndPF, type: 'person', priority: 1, label: "Nome Completo PF (Fim Linha)", multiline: true },
        { regex: labelNomeCompletoSameLinePF, type: 'person', priority: 1, label: "Nome Completo PF (Mesma Linha)", multiline: false, fallbackOrg: true },

        // Prioridade 2 (PJ Foco)
        { regex: labelNomeEmpresarialSameLine, type: 'organization', priority: 2, label: "Nome Empresarial (Mesma Linha)", multiline: false },
        { regex: labelNomeEmpresarialLineEnd, type: 'organization', priority: 2, label: "Nome Empresarial (Fim Linha)", multiline: true },
        { regex: labelRazaoSocialAnyLine, type: 'organization', priority: 2, label: "Razão Social", multiline: false },
        { regex: labelNomeCompletoFornecedorSameLine, type: 'organization', priority: 2, label: "Nome Completo Fornecedor (Mesma Linha)", multiline: false }, // Adicionado aqui

        // Prioridade 3 (Misto / Outros Labels)
        { regex: labelOtherBeneficiarySameLine, type: 'any', priority: 3, label: "Outro Beneficiário (Mesma Linha)", multiline: false },
        { regex: labelOtherBeneficiaryLineEnd, type: 'any', priority: 3, label: "Outro Beneficiário (Fim Linha)", multiline: true },
        { regex: labelPrestadorAnyLine, type: 'any', priority: 3, label: "Prestador Serviço", multiline: false },

        // Prioridade 4 (Contexto / Fonte Pagadora Genérica)
        { regex: nameAfterCnpjCpf, type: 'any', priority: 4, label: "Após CNPJ/CPF", multiline: false },
        { regex: labelFontePagadoraAnyLine, type: 'organization', priority: 4, label: "Fonte Pagadora/Empresa Genérica", multiline: false },
    ];


    for (let i = 0; i < lines.length; i++) {
        const currentLine = lines[i].trim();
        if (!currentLine) continue;

        for (const pattern of linePatterns) {
            // Se já temos um match melhor ou igual, não tentar padrões de prioridade menor
            if (pattern.priority >= bestMatchInfo.priority) continue;

            let potentialName = null;
            let currentType = pattern.type;
            let matchResult = null; // Para armazenar o resultado do match

            if (pattern.multiline) {
                if (pattern.regex.test(currentLine)) {
                    // console.log(`[Pág ${pageNumber}] DEBUG: Encontrado label multi-linha '${pattern.label}' na linha ${i + 1}: "${currentLine}"`);
                    let nameLineIndex = -1;
                    // Procurar nas próximas 2 linhas não vazias
                    let linesChecked = 0;
                    for (let j = i + 1; j < lines.length && linesChecked < 2; j++) {
                        const nextLine = lines[j].trim();
                        if (nextLine) {
                            linesChecked++;
                            if (nameLineIndex === -1) { // Pegar a primeira não vazia
                                // Validação básica: não deve ser um label conhecido ou só números/CNPJ/CPF
                                if (!/^(CNPJ|CPF|Nome|Razão|Beneficiário|Rendimento|Valor|Data|Fonte)/i.test(nextLine) && !/^\d{2,}/.test(nextLine) && !cnpjCpfPatternOnly.test(nextLine)) {
                                    nameLineIndex = j;
                                    // console.log(`[Pág ${pageNumber}] DEBUG: Linha candidata multi-linha: ${nameLineIndex + 1} -> "${nextLine}"`);
                                    break;
                                } else {
                                    // console.log(`[Pág ${pageNumber}] DEBUG: Linha ${j + 1} ignorada (parece label/dado numérico): "${nextLine}"`);
                                }
                            }
                        }
                    }

                    if (nameLineIndex !== -1) {
                        potentialName = lines[nameLineIndex].trim();
                         console.log(`[Pág ${pageNumber}] DEBUG: Match multi-linha candidato via '${pattern.label}': "${potentialName}"`);
                    }
                }
            } else { // Mesma linha
                matchResult = currentLine.match(pattern.regex);
                if (matchResult && matchResult[1]) {
                    potentialName = matchResult[1].trim();
                     // Limpeza básica CPF/CNPJ ANTES de validar
                    potentialName = potentialName.replace(cnpjCpfPatternOnly, '').trim();
                     console.log(`[Pág ${pageNumber}] DEBUG: Match mesma linha candidato via '${pattern.label}': "${potentialName}" (Original: "${matchResult[1].trim()}")`);
                }
            }

            // --- Validação e Seleção ---
            if (potentialName) {
                const cleanedName = potentialName.replace(/\s+/g, ' ').trim();
                 // Mais limpeza: remover traços no início/fim, pontos excessivos
                const finalCleanedName = cleanedName.replace(/^[\s\-.:]+|[\s\-.:]+$/g, '').replace(/\.{2,}/g, '.').trim();

                if (!finalCleanedName) continue; // Pular se a limpeza resultou em vazio

                let isValid = false;
                let validatedType = currentType; // Tipo pode mudar se 'any' ou fallback

                // Tenta validação primária
                if (currentType === 'person') {
                    isValid = isValidName(finalCleanedName, false, pattern.label);
                } else if (currentType === 'organization') {
                    isValid = isValidName(finalCleanedName, true, pattern.label);
                } else { // 'any' -> Tenta ambos, prioriza Organização primeiro por ser mais comum nesses PDFs
                    isValid = isValidName(finalCleanedName, true, pattern.label + " (Tentativa Org)");
                    if (isValid) {
                        validatedType = 'organization';
                    } else {
                        isValid = isValidName(finalCleanedName, false, pattern.label + " (Tentativa Person)");
                        if (isValid) validatedType = 'person';
                    }
                }

                // Fallback para 'Nome Completo' que pode ser PJ
                if (!isValid && pattern.fallbackOrg && currentType === 'person') {
                     // console.log(`[Pág ${pageNumber}] DEBUG: Fallback Org para '${pattern.label}': Testando "${finalCleanedName}"`);
                     isValid = isValidName(finalCleanedName, true, pattern.label + " (Fallback Org)");
                     if (isValid) {
                         validatedType = 'organization';
                         // console.log(`[Pág ${pageNumber}] DEBUG: Fallback Org SUCESSO.`);
                     }
                }


                if (isValid) {
                    // Verificar se este match é realmente melhor (menor prioridade numérica)
                    if (pattern.priority < bestMatchInfo.priority) {
                        bestMatchInfo = { name: finalCleanedName, priority: pattern.priority, label: pattern.label };
                        console.log(`[Pág ${pageNumber}] >>> Match VÁLIDO e MELHOR! Atualizado: "${bestMatchInfo.name}" [Pri: ${bestMatchInfo.priority}, Label: ${bestMatchInfo.label}, Tipo: ${validatedType}] <<<`);
                    } else {
                         // console.log(`[Pág ${pageNumber}] Match VÁLIDO, mas prioridade ${pattern.priority} não é melhor que ${bestMatchInfo.priority} ("${finalCleanedName}" vs "${bestMatchInfo.name}")`);
                    }
                } else {
                    // console.log(`[Pág ${pageNumber}] Match INVÁLIDO via '${pattern.label}': "${finalCleanedName}" (Tipo esperado/tentado: ${currentType === 'any' ? 'any' : currentType}${pattern.fallbackOrg ? '/org fallback' : ''})`);
                }
            }
        } // Fim loop patterns
    } // Fim loop lines

    if (bestMatchInfo.name) {
        console.log(`[Pág ${pageNumber}] Nome final selecionado: "${bestMatchInfo.name}" (Prioridade ${bestMatchInfo.priority}, Label: ${bestMatchInfo.label})`);
        return { nome: bestMatchInfo.name };
    } else {
        console.warn(`[Pág ${pageNumber}] Nenhum nome válido encontrado após todas as tentativas.`);
        return { nome: null };
    }
}


// Função auxiliar para verificar se um nome parece ser de PJ (heurística)
function isLikelyPJName(name) {
    if (!name) return false;
    // Considera PJ se contiver sufixos comuns, OU se tiver palavras longas em maiúsculas, OU conter números.
    const pjSuffixes = /\b(LTDA|S\.?A|S\/A|SA|CIA|EIRELI|MEI|EPP|SPE)\b/i;
    const hasLongUppercaseWord = /\b[A-Z]{4,}\b/.test(name); // Palavra com 4+ letras maiúsculas
    const hasNumber = /\d/.test(name);
    const hasOrgKeywords = /\b(SERVI[ÇC]OS|COM[ÉE]RCIO|IND[ÚU]STRIA|CONSULTORIA|ENERGIA|SOLUCOES|AUDITORES|TECNOLOGIA|EQUIPAMENTOS|OPERADOR|NACIONAL|SISTEMA|TRANSMISSAO|GERACAO)\b/i.test(name);

    return pjSuffixes.test(name) || hasLongUppercaseWord || hasNumber || hasOrgKeywords;
}

/**
 * Valida se uma string se parece com um nome de pessoa ou organização.
 * Ajustado para ser mais permissivo com nomes de PJ (Organizações).
 * @param {string} name String a ser validada.
 * @param {boolean} allowOrgKeywords Se true, aplica regras mais flexíveis para organização.
 * @param {string} contextLabel (Opcional) Label do padrão que encontrou o nome.
 * @returns {boolean} True se válido, False caso contrário.
 */
function isValidName(name, allowOrgKeywords = false, contextLabel = "Desconhecido") {
    const validationType = allowOrgKeywords ? 'Organização' : 'Pessoa';
    // Descomente para depuração intensa:
    // console.log(`[isValidName - ${validationType} - ${contextLabel}] Testando: "${name}"`);

    if (!name || typeof name !== 'string') {
        // console.log(`[isValidName Debug] Falha: Input inválido.`);
        return false;
    }
    // Limpeza mais agressiva no início/fim, mantém pontos internos. Remove $ e caracteres estranhos.
    const trimmedName = name.replace(/^[\s\-.,:;$*()\[\]{}]+|[\s\-.,:;$*()\[\]{}]+$/g, '')
                           .replace(/\s+/g, ' ')
                           .replace(/[.,:;\-_]$/, '') // Remove pontuação no final APÓS espaços normalizados
                           .trim();

    // 1. Comprimento (Relaxado para Org)
    const minLength = allowOrgKeywords ? 3 : 5; // Ex: ONS, sigla curta
    const maxLength = 150; // Aumentado
    if (trimmedName.length < minLength || trimmedName.length > maxLength) {
        // console.log(`[isValidName Debug - ${validationType}] Falha: Comprimento (${trimmedName.length}): "${trimmedName}"`);
        return false;
    }

    // 2. Caracteres inválidos (Permite & / . - para Org) - Adicionado traço aqui explicitamente
    // Removido 0-9 daqui, tratado na seção Dígitos. Adicionado () para permitir "(PF)" etc se não limpo antes.
    const allowedCharsRegex = allowOrgKeywords ? /[^a-zA-ZÀ-ÖØ-Þà-öø-ÿ\s'.\-&\/()]/ : /[^a-zA-ZÀ-ÖØ-Þà-öø-ÿ\s'.\-]/;
     if (allowedCharsRegex.test(trimmedName)) {
        // console.log(`[isValidName Debug - ${validationType}] Falha: Caractere inválido (Regex: ${allowedCharsRegex}): "${trimmedName}"`);
        return false;
    }

     // 3. Dígitos (Permitidos para Org, restrito para Pessoa)
     if (/\d/.test(trimmedName)) {
        if (!allowOrgKeywords) { // Só restringir para pessoas
            // Permite numerais romanos II-V no final E NADA MAIS
             if (!/\b(II|III|IV|V)$/i.test(trimmedName) || /\d/.test(trimmedName.replace(/\b(II|III|IV|V)$/i, '').trim())) {
                // console.log(`[isValidName Debug - Pessoa] Falha: Dígito inválido: "${trimmedName}"`);
                return false;
            }
        }
        // Se allowOrgKeywords é true, dígitos são permitidos (ex: EOL POTIGUAR B61 SPE S A).
    }

    // 4. Palavras de Exclusão Reorganizadas
    // Palavras que raramente fazem parte de QUALQUER nome (PF ou PJ)
    const universalExclusionKeywords = [
        'RUA', 'AV\\b', 'AVENIDA', 'TRAVESSA', 'ESTRADA', 'RODOVIA', 'PRAÇA', 'LARGO',
        'N[º°]', 'S/N', 'KM\\b', 'BLOCO', 'APTO', 'APARTAMENTO', 'CONJUNTO', 'ANDAR',
        'SALA', 'LOJA', 'BAIRRO', 'CIDADE', 'MUNIC[ÍI]PIO', 'ESTADO', 'UF\\b', 'CEP\\b',
        'CAIXA POSTAL', 'ENDERE[ÇC]O', 'TELEFONE', 'EMAIL', 'SITE', 'HTTP', 'WWW',
        'CPF', 'CNPJ', 'RG\\b', 'INSC', 'ESTADUAL', 'MUNICIPAL', // 'INSC' é arriscado mas comum em labels
        'PROTOCOLO', 'PROCESSO', 'PEDIDO', 'GUIA\\b', 'RECIBO', 'NOTA FISCAL', 'COMPROVANTE',
        'DECLARA[ÇC][ÃA]O', 'ASSINATURA', 'CARIMBO', 'TESTEMUNHA', 'DATA\\b', 'HORA\\b',
        'VALOR', 'TOTAL', 'P[ÁA]GINA', 'ANEXO', 'OBSERVA[ÇC][ÕO]ES', 'OBS\\b',
        'PLANO', 'SEGURO', 'AP[ÓO]LICE', 'CONTRATO', 'CONV[ÊE]NIO', 'MATR[ÍI]CULA',
        'EXAME', 'PROCEDIMENTO', 'SOLICITA[ÇC][ÃA]O', 'AUTORIZA[ÇC][ÃA]O',
        'IMPOSTO', 'RENDA', 'RETIDO', 'FONTE', 'SECRETARIA', 'MINIST[ÉE]RIO', 'FAZENDA',
        'FEDERAL', 'RECEITA', 'NATUREZA', 'RENDIMENTO', 'ALUGU[ÉE]IS', 'ROYALTIES',
        'RESPONS[ÁA]VEL', 'INFORMA[ÇÇ][ÕO]ES', 'COMPLEMENTARES', 'PAGADORA',
        'EXERC[ÍI]CIO', 'CALEND[ÁA]RIO', // Comuns em cabeçalhos
        'BENEFICI[ÁA]RIO', 'PESSOA', 'JUR[ÍI]DICA', 'F[ÍI]SICA', 'FORNECEDORA', 'SERVI[ÇC]O', // Palavras de Label
    ];
    // Palavras que indicam EMPRESA e NÃO devem estar em nome de PESSOA
    const orgSpecificKeywords = [
        'LTDA', 'S\\.A', 'S/A', '\\bSA\\b', 'CIA', 'EIRELI', 'MEI\\b', 'EPP\\b', 'SPE\\b', // Sufixos PJ
        'ASSOCIA[ÇC][ÃA]O', 'INSTITUTO', 'FUNDA[ÇC][ÃA]O', 'EMPRESA', 'EMPRESARIAL', 'SERVI[ÇC]OS',
        'CONSULTORIA', 'COM[ÉE]RCIO', 'IND[ÚU]STRIA', 'CL[ÍI]NICA', 'HOSPITAL', 'LABORAT[ÓO]RIO',
        'CONSULT[ÓO]RIO', 'CENTRO', 'GRUPO', 'COOPERATIVA', 'COMUNIT[ÁA]RIA', 'PRODUTOS',
        'PREFEITURA', 'GOVERNO', 'NACIONAL', 'SISTEMA',
        'JUR[ÍI]DICA', 'ELETRICO', 'TRANSMISSAO', 'ENERGIA', 'SOLUCOES', 'AUDITORES',
        'GERACAO', 'TECNOLOGIA', 'EQUIPAMENTOS', 'OPERADOR', // Mantido OPERADOR aqui, mas não será usado para excluir PJ
    ];

    const allWords = trimmedName.split(' ');

    // Teste de Exclusão Universal: Rejeitar se CONTIVER uma keyword universal (exceto se for única palavra e curta)
    const containsUniversalExclusion = new RegExp(`\\b(${universalExclusionKeywords.join('|')})\\b`, 'i');
    if (containsUniversalExclusion.test(trimmedName)) {
        // Permitir se a palavra de exclusão for a única palavra e tiver <= 3 letras (ex: 'AV') - Raro para nome real
        if (!(allWords.length === 1 && trimmedName.length <= 3)) {
            // console.log(`[isValidName Debug - ${validationType}] Falha: Keyword universal: "${trimmedName}"`);
            return false;
        }
    }

    // Teste de Exclusão Específico de Org (APENAS para Pessoas): Rejeitar PF se contiver keyword de PJ
    if (!allowOrgKeywords) {
        const containsOrgKeyword = new RegExp(`\\b(${orgSpecificKeywords.join('|')})\\b`, 'i');
         if (containsOrgKeyword.test(trimmedName)) {
              // console.log(`[isValidName Debug - Pessoa] Falha: Keyword de Organização encontrada: "${trimmedName}"`);
              return false;
         }
    }
    // IMPORTANTE: Não excluímos PJs baseados nas `orgSpecificKeywords`


     // 5. Pelo menos UMA palavra significativa (>1 letra OU sigla de 3+ letras maiúsculas para Org)
     const significantWords = allWords.filter(w => w.length > 1 || (allowOrgKeywords && w.length > 0 && w === w.toUpperCase()));
     if (significantWords.length < 1) {
          // console.log(`[isValidName Debug - ${validationType}] Falha: Nenhuma palavra significativa: "${trimmedName}"`);
          return false;
     }
     // Para Pessoas, exigir pelo menos duas palavras se não for nome muito curto com numeral romano
     if (!allowOrgKeywords && significantWords.length < 2 && !/\b(II|III|IV|V)$/i.test(trimmedName)) {
         // console.log(`[isValidName Debug - Pessoa] Falha: < 2 palavras signif.: "${trimmedName}"`);
         return false;
     }


    // 6. Muitas palavras curtas (ajustado)
    const shortWords = allWords.filter(word => word.length <= 3);
    // Relaxar esta regra para Org
    if (!allowOrgKeywords && shortWords.length > allWords.length / 2 && allWords.length > 3) {
        const allowedShortWordsPerson = ['de', 'da', 'do', 'dos', 'das', 'e', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'filho', 'neta', 'neto', 'junior', 'jr'];
        // Permitir siglas curtas OU numerais romanos como palavras curtas válidas para Pessoas
        if (!shortWords.every(sw => allowedShortWordsPerson.includes(sw.toLowerCase()) || /^[A-Z]{1,3}$/.test(sw) || /^(II|III|IV|V)$/i.test(sw))) {
            // console.log(`[isValidName Debug - Pessoa] Falha: Muitas palavras curtas não permitidas: "${trimmedName}"`);
            return false;
        }
    }

    // 7. Capitalização (Relaxado para Org)
    // Rejeita Pessoa se palavras longas forem todas minúsculas (mas permite ALL CAPS)
    if (!allowOrgKeywords) {
        const longWords = allWords.filter(w => w.length > 3);
        const isAllLowerCaseRelevant = longWords.length > 0 && longWords.every(w => w === w.toLowerCase() && !/\d/.test(w)); // Ignora números
        if (isAllLowerCaseRelevant && trimmedName !== trimmedName.toUpperCase()) {
             // console.log(`[isValidName Debug - Pessoa] Falha: Longas minúsculas (não ALL CAPS): "${trimmedName}"`);
             return false;
        }
    }

    // 8. Verificações Adicionais (Opcional)
    // Ex: Não começar ou terminar com preposições curtas (de, da, do, e)
    if (/^(de|da|do|dos|das|e)\b|\b(de|da|do|dos|das|e)$/i.test(trimmedName) && allWords.length > 1) {
         // console.log(`[isValidName Debug - ${validationType}] Falha: Começa/Termina com preposição curta: "${trimmedName}"`);
         return false;
    }
    // Ex: Não ser apenas números e pontuação
    if (/^[\d\s.,\-/\\]+$/.test(trimmedName)) {
        // console.log(`[isValidName Debug - ${validationType}] Falha: Apenas números/pontuação: "${trimmedName}"`);
        return false;
    }

    // Se passou por todas as verificações
    console.log(`[isValidName - ${validationType} - ${contextLabel}] SUCESSO: "${trimmedName}"`);
    return true;
}

// *** NOVA FUNÇÃO: Pré-processamento da imagem (Upscaling) ***
async function preprocessImage(image, scaleFactor = 2) {
    return new Promise((resolve) => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = image.width * scaleFactor;
        canvas.height = image.height * scaleFactor;
        ctx.scale(scaleFactor, scaleFactor);
        ctx.drawImage(image, 0, 0);
        resolve(canvas);
    });
}


// Função para processar uma única página do PDF (MODIFICADA)
async function processarPagina(pdfJsDoc, pdfLibDoc, pageNum, pageIndex, totalPages, extractedNames) {
    let nomeIdentificado = null;
    let canvas = null;

    try {
        // --- PARTE 1: Extração de Nome ---
        if (pdfJsDoc) {
            displayLogMessage(`Processando página ${pageNum}/${totalPages}... (Extraindo nome)`);
            const page = await pdfJsDoc.getPage(pageNum);
            const viewport = page.getViewport({ scale: 1.5 }); // Escala 1.5 é um bom compromisso

            let needCanvas = false;
            let textoExtraido = null;

            try {
                const textContent = await page.getTextContent();
                textoExtraido = textContent.items.map(item => item.str).join('\n');
                const info = extractNameInfo(textoExtraido, pageNum, false);
                nomeIdentificado = info.nome;
                if (!nomeIdentificado && Tesseract) needCanvas = true;
            } catch (textExtractError) {
                console.error(`Erro texto direto pág ${pageNum}:`, textExtractError);
                 if (Tesseract) needCanvas = true;
            }

            if (needCanvas) {
                canvas = document.createElement("canvas");
                const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
                canvas.width = viewport.width; canvas.height = viewport.height;
                const renderContext = { canvasContext: context, viewport: viewport };
                try {
                    await page.render(renderContext).promise;
                    displayLogMessage(`OCR Página ${pageNum}...`);
                    console.log(`[Pág ${pageNum}] Iniciando OCR...`);

                    const enlargedCanvas = await preprocessImage(canvas, 2); // Aumenta a escala para 2x
                    displayLogMessage(`Upscaling página ${pageNum}...`);

                    let worker = null;
                    try {
                        worker = await Tesseract.createWorker('por', 1, {
                            logger: m => { if(m.status === 'recognizing text') displayLogMessage(`OCR Pág ${pageNum}: ${(m.progress * 100).toFixed(0)}%`); },
                            // Adicione configurações do Tesseract aqui, se necessário
                            tessedit_pageseg_mode: '6', // Modo de segmentação de página (experimente!)
                            //tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz .-',  // Defina os caracteres esperados
                        });
                        const { data: { text: ocrText } } = await worker.recognize(enlargedCanvas); // Usa o canvas ampliado
                        console.log(`[Pág ${pageNum}] OCR concluído.`);
                        if (!nomeIdentificado) { // Tenta de novo com OCR apenas se falhou antes
                            const infoOcr = extractNameInfo(ocrText, pageNum, true);
                            nomeIdentificado = infoOcr.nome;
                        }
                    } catch (ocrError) { console.error(`Erro OCR pág ${pageNum}:`, ocrError); displayLogMessage(`Erro OCR pág ${pageNum}.`);
                    } finally { if (worker) await worker.terminate(); }
                } catch (renderError) { console.error(`Erro render pág ${pageNum}:`, renderError); displayLogMessage(`Erro render pág ${pageNum}.`); }
            }
        } else {
            displayLogMessage(`Aviso: pdf.js não carregado pág ${pageNum}.`);
        }

        return { pageNum: pageNum, pageIndex: pageIndex, nomeIdentificado: nomeIdentificado, pdfLibDoc: pdfLibDoc };

    } catch (error) {
        console.error(`Erro fatal pág ${pageNum}:`, error);
        displayLogMessage(`Erro grave pág ${pageNum}.`);
        return { pageNum: pageNum, pageIndex: pageIndex, nomeIdentificado: null, pdfLibDoc: null };
    } finally {
        if (canvas) { canvas.width = 0; canvas.height = 0; canvas = null; }
    }
}

// Função principal processarPdf (com lógica de reagrupamento)
async function processarPdf() {
    const fileInput = document.getElementById("pdfUpload");
    const file = fileInput.files[0];
    const processarPDFButton = document.getElementById("processarPDF");
    const pdfPagesContainer = document.getElementById("pdf-pages-container");
    const defaultGroupName = "Padrão (Não Identificado)"; // Nome mais claro

    if (!Tesseract || !pdfjsLib || !PDFLib) { alert("Erro: Bibliotecas não carregadas."); return; }
    if (!file) { alert("Selecione um arquivo PDF."); return; }
    if (file.type !== "application/pdf") { alert("Selecione um arquivo PDF válido."); return; }

    pdfPagesContainer.innerHTML = "";
    displayLogMessage("Iniciando processamento...");
    processarPDFButton.textContent = "Processando...";
    processarPDFButton.disabled = true;

    let pdfJsDoc = null; let pdfLibDoc = null; let numPages = 0;

    try {
        const originalArrayBuffer = await readFileAsync(file);
        displayLogMessage("Arquivo lido. Carregando estruturas...");

        try {
            pdfLibDoc = await PDFLib.PDFDocument.load(originalArrayBuffer.slice(0));
            numPages = pdfLibDoc.getPageCount();
            displayLogMessage(`pdf-lib OK (${numPages} pgs).`);
        } catch (pdfLibError) { console.error("Erro pdf-lib:", pdfLibError); displayLogMessage(`Erro crítico pdf-lib: ${pdfLibError.message}.`); alert("Erro estrutura PDF (pdf-lib)."); throw pdfLibError; }

        try {
            const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(originalArrayBuffer.slice(0)) });
            pdfJsDoc = await loadingTask.promise;
            displayLogMessage(`pdf-lib OK. pdf.js OK.`);
        } catch (pdfjsError) { console.error("Erro pdf.js:", pdfjsError); displayLogMessage(`Aviso pdf.js: ${pdfjsError.message}.`); }

        displayLogMessage(`Iniciando processamento de ${numPages} páginas...`);
        let processingPromises = Array.from({ length: numPages }, (_, i) => processarPagina(pdfJsDoc, pdfLibDoc, i + 1, i, numPages));
        const pageResults = await Promise.all(processingPromises);

        // --- Agrupamento Inicial ---
        const groupedPages = {};
        pageResults.forEach(result => {
            const nome = result.nomeIdentificado || defaultGroupName;
            if (!groupedPages[nome]) {
                groupedPages[nome] = [];
            }
            groupedPages[nome].push(result);
        });

        // --- Etapa de Reagrupamento (Heurística para Pares PJ) ---
        displayLogMessage("Tentando reagrupar páginas não identificadas...");
        if (groupedPages[defaultGroupName]) {
            const pagesToReGroup = [...groupedPages[defaultGroupName]]; // Copia para iterar e modificar
            let movedCount = 0;

            for (const currentPage of pagesToReGroup) {
                const currentIndex = currentPage.pageIndex;
                if (currentIndex > 0) {
                    const previousPage = pageResults[currentIndex - 1];
                    const previousName = previousPage.nomeIdentificado;

                    // Se a página anterior foi identificada E parece ser um nome de PJ
                    if (previousName && previousName !== defaultGroupName && isLikelyPJName(previousName)) {
                        console.log(`[Reagrupamento] Pág ${currentPage.pageNum} ("${defaultGroupName}") segue Pág ${previousPage.pageNum} ("${previousName}", PJ provável). Movendo...`);

                        // Adiciona a página atual ao grupo da página anterior
                        if (!groupedPages[previousName]) {
                            groupedPages[previousName] = []; // Segurança, caso o grupo não exista
                        }
                        groupedPages[previousName].push(currentPage);
                        // Ordena por pageNum dentro do grupo após adicionar
                        groupedPages[previousName].sort((a, b) => a.pageNum - b.pageNum);


                        // Remove a página atual do grupo "Padrão" original
                        const indexInDefault = groupedPages[defaultGroupName].findIndex(p => p.pageIndex === currentIndex);
                        if (indexInDefault > -1) {
                            groupedPages[defaultGroupName].splice(indexInDefault, 1);
                            movedCount++;
                        }
                    } else {
                         console.log(`[Reagrupamento] Pág ${currentPage.pageNum} ("${defaultGroupName}") segue Pág ${previousPage.pageNum} ("${previousName || defaultGroupName}", não parece PJ ou não identificado). Mantendo em Padrão.`);
                    }
                }
            }

            // Limpa o grupo Padrão se ficou vazio
            if (groupedPages[defaultGroupName] && groupedPages[defaultGroupName].length === 0) {
                delete groupedPages[defaultGroupName];
            }
            displayLogMessage(`Reagrupamento: ${movedCount} páginas movidas do grupo padrão.`);
        } else {
             displayLogMessage("Nenhuma página no grupo padrão para reagrupar.");
        }


        // --- Criar e exibir os PDFs combinados ---
        displayLogMessage("Gerando arquivos PDF agrupados...");
        for (const nome in groupedPages) {
            const pages = groupedPages[nome];
            if (pages.length === 0) continue; // Segurança extra

            const combinedPdfDoc = await PDFLib.PDFDocument.create();

            // Adiciona as páginas na ordem correta
            for (const pageInfo of pages) { // pages já deve estar ordenado pelo pageNum se foi reagrupado
                if (pageInfo.pdfLibDoc) {
                    try {
                        const [copiedPage] = await combinedPdfDoc.copyPages(pageInfo.pdfLibDoc, [pageInfo.pageIndex]);
                        combinedPdfDoc.addPage(copiedPage);
                    } catch (copyError) {
                         console.error(`Erro ao copiar página ${pageInfo.pageNum} (índice ${pageInfo.pageIndex}) para o grupo "${nome}":`, copyError);
                         displayLogMessage(`Erro ao copiar pág ${pageInfo.pageNum} para "${nome}".`);
                         // Opcional: Adicionar um item de erro na UI para este grupo?
                    }
                } else {
                    console.warn(`Aviso: pdfLibDoc ausente para página ${pageInfo.pageNum} no grupo "${nome}".`);
                }
            }

             if (combinedPdfDoc.getPageCount() === 0) {
                console.warn(`Aviso: Nenhum PDF gerado para o grupo "${nome}" pois não foi possível copiar páginas.`);
                continue; // Pula para o próximo grupo se nenhuma página foi adicionada
            }


            const pdfBytes = await combinedPdfDoc.save();
            const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });
            const pdfDataUri = URL.createObjectURL(pdfBlob);

            // Remove caracteres inválidos e espaços múltiplos do nome do arquivo
            const safeFileNameBase = nome.toUpperCase()
                                      .replace(/[/\\?%*:|"<>.]+/g, '') // Remove caracteres inválidos
                                      .replace(/\s+/g, '_') // Substitui espaços por underscore
                                      .substring(0, 100); // Limita o comprimento base
            const downloadFileName = `${safeFileNameBase}_(${pages.length}pags).pdf`;

            const downloadLink = document.createElement("a");
            downloadLink.href = pdfDataUri;
            downloadLink.download = downloadFileName;
            // Adapta o texto do link para caber melhor
            const linkText = nome.length > 40 ? nome.substring(0, 37) + '...' : nome;
            downloadLink.textContent = `${linkText} (${pages.length} pág.)`;
            downloadLink.title = `${nome} (${pages.length} páginas)`; // Tooltip com nome completo
            downloadLink.target = "_blank";
             // Garante que o objeto URL seja revogado após o clique ou download
            const revokeObjectUrl = () => {
                setTimeout(() => {
                    URL.revokeObjectURL(pdfDataUri);
                    downloadLink.removeEventListener('click', revokeObjectUrl); // Remove o listener para limpeza
                     console.log("Revoked URL for:", downloadFileName);
                }, 100); // Pequeno delay
            };
            downloadLink.addEventListener('click', revokeObjectUrl , { once: false }); // Usar once:false pode ser mais seguro se o clique não iniciar download imediatamente


            const pageItem = document.createElement("div");
            pageItem.classList.add("custom-pdf-page-item");
            pageItem.appendChild(downloadLink);
            pdfPagesContainer.appendChild(pageItem);
        }

        displayLogMessage("Concluído!");
        scrollToPdfPagesContainer(); // Rola para a seção de resultados

    } catch (error) {
        console.error("Erro processamento:", error);
        displayLogMessage(`Erro: ${error.message || 'Erro desconhecido.'}`);
        alert("Ocorreu um erro ao processar o PDF.");
    } finally {
        processarPDFButton.textContent = "Processar PDF";
        processarPDFButton.disabled = false;
    }
}

// --- Inicialização --- (sem alterações)
document.addEventListener('DOMContentLoaded', function () {
    const pdfjsLibUrl = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/";
    const pdfjsWorkerUrl = pdfjsLibUrl + "build/pdf.worker.min.js";
    const pdfjsLibBuildUrl = pdfjsLibUrl + "build/pdf.min.js";
    const tesseractUrl = "https://cdn.jsdelivr.net/npm/tesseract.js@5";
    const pdfLibUrl = "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js";
    const jspdfUrl = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
    const initialProcessButton = document.getElementById("processarPDF");
    const fileInput = document.getElementById("pdfUpload");

    if (fileInput) fileInput.addEventListener('change', updateFileName);
    else console.error("Input 'pdfUpload' não encontrado!");
    if (initialProcessButton) { initialProcessButton.disabled = true; initialProcessButton.textContent = "Carregando..."; }
    displayLogMessage("Carregando bibliotecas...");

    loadScript(pdfjsLibBuildUrl, () => {
        console.log("pdf.js carregado.");
        if (typeof window.pdfjsLib === 'undefined') { console.error("pdfjsLib não definido."); displayLogMessage("Erro pdf.js."); if(initialProcessButton) initialProcessButton.disabled = true; return; }
        pdfjsLib = window.pdfjsLib; pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
        loadScript(jspdfUrl, () => {
            console.log("jsPDF carregado."); if (typeof window.jspdf?.jsPDF !== 'undefined') { jsPDF = window.jspdf.jsPDF; } else { console.warn("jsPDF não carregado."); }
            loadScript(pdfLibUrl, () => {
                console.log("pdf-lib carregado."); if (typeof window.PDFLib === 'undefined') { console.error("PDFLib não definido."); displayLogMessage("Erro pdf-lib."); if(initialProcessButton) initialProcessButton.disabled = true; return; }
                PDFLib = window.PDFLib;
                loadScript(tesseractUrl + '/dist/tesseract.min.js', () => {
                    console.log("Tesseract.js carregado."); if (typeof window.Tesseract === 'undefined') { console.error("Tesseract não definido."); displayLogMessage("Erro Tesseract."); if(initialProcessButton) initialProcessButton.disabled = true; return; }
                    Tesseract = window.Tesseract;
                    if (initialProcessButton) { initialProcessButton.addEventListener("click", processarPdf); initialProcessButton.disabled = false; initialProcessButton.textContent = "Processar PDF"; updateFileName(); }
                    else { console.error("Botão 'processarPDF' não encontrado."); }
                }, 'tesseract-script');
            }, 'pdf-lib-script');
        }, 'jspdf-script');
    }, 'pdfjs-script');
});