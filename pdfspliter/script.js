// Configuração e utilitários globais (Android/Browser)

// Bibliotecas carregadas dinamicamente
let pdfjsLib = null;
let PDFLib = null;

// Referência global para o botão de instalação PWA
let installBtn = null;

// Mapa de promessas de OCR (Android)
const ocrPromises = {};

// Callback chamado pelo Android ao finalizar OCR
function onOcrResult(callbackId, text) {
    if (ocrPromises[callbackId]) {
        console.log(`[JS] Retorno de OCR recebido para ID: ${callbackId}`);
        ocrPromises[callbackId](text);
        delete ocrPromises[callbackId];
    }
}

// Solicita OCR ao Android (ou retorna vazio no browser)
function performAndroidOCR(base64Image) {
    return new Promise((resolve) => {
        if (window.Android && window.Android.performOCR) {
            const callbackId = 'ocr_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            ocrPromises[callbackId] = resolve;
            const cleanBase64 = base64Image.replace(/^data:image\/(png|jpg|jpeg);base64,/, "");
            window.Android.performOCR(cleanBase64, callbackId);
        } else {
            // Fallback para browser comum
            resolve("");
        }
    });
}

// Envia PDF final para Android ou faz download no browser
function nativeDownload(fileName, blob) {
    const reader = new FileReader();
    reader.onload = function (event) {
        const base64Data = event.target.result.split(',')[1];
        if (window.Android && typeof window.Android.downloadPdf === 'function') {
            window.Android.downloadPdf(base64Data, fileName);

// --- PWA: Registrar Service Worker ---
if ('serviceWorker' in navigator) {
    window.addEventListener('load', function() {
        navigator.serviceWorker.register('service-worker.js').then(function(registration) {
            console.log('[PWA] Service Worker registrado com sucesso:', registration.scope);
        }, function(err) {
            console.log('[PWA] Falha ao registrar Service Worker:', err);
        });
    });
}
        } else {
            // Fallback download navegador
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = fileName;
            a.click();
        }
    };
    reader.readAsDataURL(blob);
}

// UI: log e atualização de nome de arquivo
function displayLogMessage(msg) {
    const el = document.getElementById("log-messages");
    if (el) el.innerText = msg;
    console.log("[LogUI]", msg);
}

function updateFileName() {
    const fileInput = document.getElementById("pdfUpload");
    const nameSpan = document.getElementById("file-selected-name");
    const btn = document.getElementById("processarPDF");
    const container = document.getElementById("pdf-pages-container");

    const allFiles = fileInput.files;
    const pdfFiles = Array.from(allFiles).filter(f => f.type === 'application/pdf');

    if (allFiles.length > 0 && pdfFiles.length === 0) {
        alert("Nenhum arquivo PDF válido selecionado. Apenas arquivos PDF são permitidos.");
        fileInput.value = "";
        nameSpan.textContent = 'Nenhum arquivo selecionado';
        if (btn) btn.disabled = true;
        return;
    }

    if (allFiles.length > pdfFiles.length) {
        alert('Alguns arquivos não eram PDFs e foram ignorados.');
    }

    if (pdfFiles.length > 0) {
        nameSpan.textContent = pdfFiles.length === 1 ?
            pdfFiles[0].name : `${pdfFiles.length} arquivos selecionados`;
        if (btn) btn.disabled = false;
        if (container) container.innerHTML = "";
        displayLogMessage("Pronto para processar.");
    } else {
        nameSpan.textContent = "Nenhum arquivo selecionado";
        if (btn) btn.disabled = true;
    }
}

function scrollToResults() {
    const container = document.getElementById("pdf-pages-container");
    if (container) {
        container.scrollIntoView({ behavior: "smooth", block: "start" });
    }
}

// Menu lateral e integração Android
function openNav() { document.getElementById("mySidenav").style.width = "250px"; }
function closeNav() { document.getElementById("mySidenav").style.width = "0"; }
function exitApp() {
    if (window.Android && typeof window.Android.exitApp === 'function') {
        window.Android.exitApp();
    }
}


/* ========================================================
   2. Lógica de Extração de Nomes (Inteligência Melhorada)
   ======================================================== */

function extractNameInfo(textToSearch, pageNumber, source = "Texto") {
    if (!textToSearch || textToSearch.length < 5) return { nome: null };

    const cleanText = textToSearch.replace(/\\n/g, '\n').replace(/\r/g, '');
    const lines = cleanText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    const patterns = [
        { reg: /Nome.*da.*Fonte.*Pagadora/i, nextLine: true, type: 'IR_PJ' },
        { reg: /Pessoa.*F[ií]sica.*Benefici[áa]ria/i, nextLine: true, type: 'IR_PF' },
        { reg: /Benefici[áa]rio.*dos.*Rendimentos/i, nextLine: true, type: 'IR_PF' },
        { reg: /Nome\s*do\s*Benefici[áa]rio\s*[:\-]?\s*(.+)/i, type: 'Geral' },
        { reg: /Nome\s*da\s*Fonte\s*Pagadora\s*[:\-]?\s*(.+)/i, type: 'Geral' },
        { reg: /Raz[ãa]o\s*Social\s*[:\-]?\s*(.+)/i, type: 'PJ' },
        { reg: /Nome\s*Empresarial\s*[:\-]?\s*(.+)/i, type: 'PJ' },
        { reg: /^Nome\s*[:\-]\s*(.+)/i, type: 'Simples' },
        { reg: /^Benefici[áa]rio\s*[:\-]\s*(.+)/i, type: 'Simples' }
    ];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const p of patterns) {
            let possibleName = null;
            if (p.nextLine) {
                if (p.reg.test(line) && i + 1 < lines.length) {
                    let offset = 1;
                    while (i + offset < lines.length) {
                        const nextLineCandidate = lines[i + offset];
                        if (nextLineCandidate.length > 3 && !/^(CPF|CNPJ|DATA|VALOR)/i.test(nextLineCandidate)) {
                            possibleName = nextLineCandidate;
                            break;
                        }
                        offset++;
                        if (offset > 3) break;
                    }
                }
            } else {
                const match = line.match(p.reg);
                if (match && match[1]) possibleName = match[1];
            }
            if (possibleName) {
                let cleanName = cleanNameStr(possibleName);
                if (isValidName(cleanName)) {
                    return { nome: cleanName };
                }
            }
        }
    }

    for (const line of lines) {
        if (/^[A-Z\s]{10,}$/.test(line)) {
            let clean = cleanNameStr(line);
            if (isValidName(clean) && !/(IMPOSTO|RENDA|FEDERAL|RECEITA|BRASIL|MINISTERIO|COMPROVANTE)/i.test(clean)) {
                return { nome: clean };
            }
        }
    }

    return { nome: null };
}

function cleanNameStr(str) {
    if (!str) return "";
    str = str.split(/(CPF|CNPJ|CNPJ\/CPF|Valores|Pagamento)/i)[0];
    str = str.replace(/\d{2,}\.?\d{3}\.?\d{3}[\/\-]?\d{0,4}-?\d{2}/g, '');
    return str.replace(/[\.\-:,;]+$/, '').trim();
}

function isValidName(name) {
    if (!name || name.length < 4) return false;
    const clean = name.toUpperCase();
    if (/^[\d\s\.\-\/]+$/.test(clean)) return false;
    const forbidden = [
        'DATA', 'VALOR', 'TOTAL', 'RENDIMENTO', 'IMPOSTO', 'LIQUIDO',
        'RETIDO', 'FONTE', 'PAGADORA', 'BENEFICIARIA', 'EXERCICIO',
        'ANEXO', 'PAGINA', 'DECLARACAO', 'ASSINATURA', 'CPF', 'CNPJ',
        'OBSERVACAO', 'REAIS', 'CENTAVOS'
    ];
    if (forbidden.includes(clean)) return false;
    if (clean.includes("MINISTERIO") || clean.includes("SECRETARIA")) return false;
    return true;
}

/* ========================================================
   3. Processamento Principal
   ======================================================== */

async function processarPagina(pdfJsDoc, pdfLibDoc, pageNum, pageIndex, total) {
    let nomeIdentificado = null;
    try {
        displayLogMessage(`Processando pág ${pageNum}/${total}...`);
        const page = await pdfJsDoc.getPage(pageNum);
        try {
            const textContent = await page.getTextContent();
            const textStr = textContent.items.map(s => s.str).join('\n');
            if (textStr.length > 50) {
                const info = extractNameInfo(textStr, pageNum, "Texto Digital");
                nomeIdentificado = info.nome;
            }
        } catch (e) {
            console.error("Erro ao ler texto digital", e);
        }

        if (!nomeIdentificado) {
            displayLogMessage(`Aplicando OCR na pág ${pageNum}...`);
            const viewport = page.getViewport({ scale: 2.0 });
            const canvas = document.createElement("canvas");
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            const ctx = canvas.getContext("2d");
            await page.render({ canvasContext: ctx, viewport: viewport }).promise;
            const base64Image = canvas.toDataURL('image/jpeg', 0.9);
            const ocrText = await performAndroidOCR(base64Image);
            if (ocrText && ocrText.length > 10) {
                const infoOcr = extractNameInfo(ocrText, pageNum, "OCR Nativo");
                nomeIdentificado = infoOcr.nome;
            }
        }

        return { pageIndex, pageNum, nomeIdentificado, pdfLibDoc };
    } catch (err) {
        console.error("Erro processamento pág " + pageNum, err);
        return { pageIndex, pageNum, nomeIdentificado: null, pdfLibDoc };
    }
}

async function processarPdf() {
    const fileInput = document.getElementById("pdfUpload");
    const container = document.getElementById("pdf-pages-container");
    const btn = document.getElementById("processarPDF");
    const pdfFiles = Array.from(fileInput.files).filter(f => f.type === 'application/pdf');

    if (pdfFiles.length === 0) {
        alert("Por favor, selecione pelo menos um arquivo PDF válido.");
        return;
    }

    btn.disabled = true;
    btn.textContent = "Processando...";
    container.innerHTML = "";

    try {
        let allResults = [];
        for (const file of pdfFiles) {
            displayLogMessage(`Lendo arquivo: ${file.name}`);
            const buffer = await file.arrayBuffer();
            const pdfLibDoc = await PDFLib.PDFDocument.load(buffer);
            const pdfJsDoc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
            const numPages = pdfLibDoc.getPageCount();
            for (let i = 0; i < numPages; i++) {
                const res = await processarPagina(pdfJsDoc, pdfLibDoc, i + 1, i, numPages);
                allResults.push(res);
            }
        }

        const groups = {};
        const UNKNOWN = "Outros_Documentos";
        let lastValidName = null;

        allResults.forEach(p => {
            let groupName = p.nomeIdentificado;
            if (groupName) {
                lastValidName = groupName;
            } else {
                if (lastValidName) {
                    groupName = lastValidName;
                } else {
                    groupName = UNKNOWN;
                }
            }
            if (!groups[groupName]) groups[groupName] = [];
            groups[groupName].push(p);
        });

        displayLogMessage("Gerando arquivos finais...");

        for (const [nome, paginas] of Object.entries(groups)) {
            if (paginas.length === 0) continue;
            const newPdf = await PDFLib.PDFDocument.create();
            for (const p of paginas) {
                const [cp] = await newPdf.copyPages(p.pdfLibDoc, [p.pageIndex]);
                newPdf.addPage(cp);
            }
            const pdfBytes = await newPdf.save();
            const blob = new Blob([pdfBytes], { type: 'application/pdf' });
            const safeName = nome.replace(/[^a-zA-Z0-9_\- áàãâéêíóõôúçÁÀÃÂÉÊÍÓÕÔÚÇ]/g, '').trim() + ".pdf";

            const div = document.createElement("div");
            div.className = "custom-pdf-page-item";
            div.style.cssText = "margin: 10px 0; padding: 15px; border: 1px solid #ddd; border-radius: 8px; background-color: #f9f9f9; display: flex; justify-content: space-between; align-items: center;";

            const label = document.createElement("div");
            label.innerHTML = `<strong>${safeName}</strong><br><small>${paginas.length} página(s)</small>`;

            const b = document.createElement("button");
            b.className = "button1";
            b.style.padding = "8px 16px";
            b.textContent = "Baixar";
            b.onclick = () => {
                b.disabled = true;
                b.textContent = "Salvando...";
                nativeDownload(safeName, blob);
                setTimeout(() => {
                    b.disabled = false;
                    b.textContent = "Baixar Novamente";
                }, 3000);
            };

            div.appendChild(label);
            div.appendChild(b);
            container.appendChild(div);
        }

        displayLogMessage("Processamento concluído!");
        scrollToResults();

    } catch (e) {
        console.error(e);
        displayLogMessage("Erro Crítico: " + e.message);
        alert("Ocorreu um erro no processamento.\n" + e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = "Processar PDF";
    }
}

function updateUI(translations) {
    document.querySelectorAll('[data-i18n]').forEach(element => {
        const key = element.getAttribute('data-i18n');
        if (translations[key]) {
            element.textContent = translations[key];
        }
    });
}


function loadScript(src, cb) {
    const s = document.createElement('script');
    s.src = src;
    s.onload = cb;
    s.onerror = () => displayLogMessage("Erro ao carregar " + src);
    document.head.appendChild(s);
}

document.addEventListener("DOMContentLoaded", () => {
    // Esconde o botão de instalar app se já estiver instalado (PWA/standalone)
    installBtn = document.getElementById('installPwaBtn');
    function isAppInstalled() {
        return (
            window.matchMedia('(display-mode: standalone)').matches ||
            window.matchMedia('(display-mode: minimal-ui)').matches ||
            window.matchMedia('(display-mode: fullscreen)').matches ||
            (window.navigator.standalone === true)
        );
    }
    if (installBtn && isAppInstalled()) {
        installBtn.style.display = 'none';
    }

    const btn = document.getElementById("processarPDF");
    if (btn) {
        btn.disabled = true;
        displayLogMessage("Carregando sistema...");
        loadScript("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js", () => {
            pdfjsLib = window.pdfjsLib;
            pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js";
            loadScript("https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js", () => {
                PDFLib = window.PDFLib;
                btn.disabled = false;
                displayLogMessage("Pronto para processar. Selecione arquivos PDF.");
                btn.addEventListener("click", processarPdf);
                const upload = document.getElementById("pdfUpload");
                if (upload) upload.addEventListener("change", updateFileName);
            });
        });
    }


    // --- PWA: Instalar App (com feedback visual) ---
    let deferredPrompt = null;
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        if (installBtn) {
            installBtn.style.display = 'block';
            installBtn.classList.remove('success', 'error');
            installBtn.textContent = 'Instalar App';
        }
    });
    if (installBtn) {
        installBtn.addEventListener('click', async () => {
            if (deferredPrompt) {
                try {
                    deferredPrompt.prompt();
                    const { outcome } = await deferredPrompt.userChoice;
                    if (outcome === 'accepted') {
                        installBtn.classList.add('success');
                        installBtn.textContent = 'App instalado!';
                        setTimeout(() => {
                            installBtn.style.display = 'none';
                            installBtn.classList.remove('success');
                            installBtn.textContent = 'Instalar App';
                        }, 2000);
                    } else {
                        installBtn.classList.add('error');
                        installBtn.textContent = 'Instalação cancelada';
                        setTimeout(() => {
                            installBtn.classList.remove('error');
                            installBtn.textContent = 'Instalar App';
                        }, 2000);
                    }
                } catch (err) {
                    installBtn.classList.add('error');
                    installBtn.textContent = 'Erro ao instalar';
                    setTimeout(() => {
                        installBtn.classList.remove('error');
                        installBtn.textContent = 'Instalar App';
                    }, 2000);
                }
                deferredPrompt = null;
            }
        });
    }

    const userLang = (navigator.language || navigator.userLanguage).split('-')[0];
    const select = document.getElementById('language-select');
    if (select) {
        select.value = userLang;
    }
    // ...existing code...
});
