// Menu lateral (Sidenav)
function openNav() {
    document.getElementById("mySidenav").style.width = "250px";
    if (typeof isAppInstalled === 'function' && typeof hideInstallBtn === 'function') {
        if (isAppInstalled()) hideInstallBtn();
    }
}

function closeNav() {
    document.getElementById("mySidenav").style.width = "0";
}

// --- PWA: Instalar App (com feedback visual) ---
let deferredPrompt = null;
const installBtn = document.getElementById('installPwaBtn');
function hideInstallBtn() {
    if (installBtn) installBtn.style.display = 'none';
}
function isAppInstalled() {
    // Checa standalone (PWA instalado) e display-mode
    if (window.matchMedia('(display-mode: standalone)').matches) return true;
    if (window.navigator.standalone === true) return true;
    // Checa se já existe service worker controlando e não há prompt
    if (window.matchMedia('(display-mode: minimal-ui)').matches) return true;
    // iOS: verifica se está rodando como app
    if (window.navigator && window.navigator.standalone) return true;
    // Android Chrome: verifica se não há prompt e já está instalado
    if (window.matchMedia('(display-mode: fullscreen)').matches) return true;
    return false;
}
if (isAppInstalled()) {
    hideInstallBtn();
}
window.addEventListener('appinstalled', hideInstallBtn);
window.addEventListener('DOMContentLoaded', function() {
    if (isAppInstalled()) hideInstallBtn();
});
window.addEventListener('beforeinstallprompt', (e) => {
    if (isAppInstalled()) {
        hideInstallBtn();
        return;
    }
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

// Carrega jsPDF e pdf-lib de forma assíncrona
let jsPDF;
let PDFLib;

// Rola para container de páginas processadas
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

// Carrega scripts dinamicamente (evita duplicidade)
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

// Log de status para UI e console
function displayLogMessage(message) {
    const logMessages = document.getElementById("log-messages");
    if (logMessages) {
        logMessages.textContent = message;
    }
    console.log("Log:", message);
}

// Lê arquivo como ArrayBuffer (async)
function readFileAsync(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => resolve(event.target.result);
        reader.onerror = (event) => reject(new Error(`Erro ao ler o arquivo: ${event.target.error}`));
        reader.readAsArrayBuffer(file);
    });
}

// Atualiza nome do arquivo selecionado na UI
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
    // Limpa resultados anteriores
    if (pdfPagesContainer) pdfPagesContainer.innerHTML = "";

    // Atualiza mensagem de log conforme estado das libs/botão
    if (PDFLib && processButton && !processButton.disabled) {
        displayLogMessage("Pronto para processar. Selecione um PDF.");
    } else if (!PDFLib) {
        displayLogMessage("Carregando bibliotecas, aguarde...");
    } else {
        displayLogMessage("Inicializando...");
    }
};


// Processa uma única página do PDF (simplificado)
async function processarPagina(pdfLibDoc, pageIndex, totalPages) {
    try {
        const newPdfDoc = await PDFLib.PDFDocument.create();
        const [copiedPage] = await newPdfDoc.copyPages(pdfLibDoc, [pageIndex]);
        newPdfDoc.addPage(copiedPage);

        const pdfBytes = await newPdfDoc.save();
        const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });
        const pdfDataUri = URL.createObjectURL(pdfBlob);

        return { pageIndex: pageIndex, pdfDataUri: pdfDataUri };

    } catch (error) {
        console.error(`Erro na página ${pageIndex + 1}:`, error);
        displayLogMessage(`Erro ao processar página ${pageIndex + 1}.`);
        return { pageIndex: pageIndex, pdfDataUri: null };
    }
}

// Função principal para processar PDF (simplificado)
async function processarPdf() {
    const fileInput = document.getElementById("pdfUpload");
    const file = fileInput.files[0];
    const processarPDFButton = document.getElementById("processarPDF");
    const pdfPagesContainer = document.getElementById("pdf-pages-container");

    if (!PDFLib) { alert("Erro: Biblioteca pdf-lib não carregada."); return; }
    if (!file) { alert("Selecione um arquivo PDF."); return; }
    if (file.type !== "application/pdf") { alert("Selecione um arquivo PDF válido."); return; }

    pdfPagesContainer.innerHTML = "";
    displayLogMessage("Iniciando processamento...");
    processarPDFButton.textContent = "Processando...";
    processarPDFButton.disabled = true;

    try {
        const originalArrayBuffer = await readFileAsync(file);
        displayLogMessage("Arquivo lido. Carregando PDF...");

        const pdfLibDoc = await PDFLib.PDFDocument.load(originalArrayBuffer.slice(0));
        const numPages = pdfLibDoc.getPageCount();
        displayLogMessage(`PDF carregado com ${numPages} páginas.`);

        const processingPromises = Array.from({ length: numPages }, (_, i) => processarPagina(pdfLibDoc, i, numPages));
        const pageResults = await Promise.all(processingPromises);

        displayLogMessage("Gerando links para download...");
        for (let i = 0; i < numPages; i++) {
            const result = pageResults[i];
            if (result.pdfDataUri) {
                const downloadFileName = `Página${i + 1}.pdf`;

                const downloadLink = document.createElement("a");
                downloadLink.href = result.pdfDataUri;
                downloadLink.download = downloadFileName;
                downloadLink.textContent = `Página ${i + 1}`;
                downloadLink.target = "_blank";

                const revokeObjectUrl = () => {
                    setTimeout(() => {
                        URL.revokeObjectURL(result.pdfDataUri);
                        downloadLink.removeEventListener('click', revokeObjectUrl);
                        console.log("Revoked URL for:", downloadFileName);
                    }, 100);
                };
                downloadLink.addEventListener('click', revokeObjectUrl, { once: false });

                const pageItem = document.createElement("div");
                pageItem.classList.add("custom-pdf-page-item");
                pageItem.appendChild(downloadLink);
                pdfPagesContainer.appendChild(pageItem);
            } else {
                console.warn(`Falha ao processar página ${i + 1}.`);
                displayLogMessage(`Falha ao processar página ${i + 1}.`);
            }
        }

        displayLogMessage("Concluído!");
        scrollToPdfPagesContainer();

    } catch (error) {
        console.error("Erro processamento:", error);
        displayLogMessage(`Erro: ${error.message || 'Erro desconhecido.'}`);
        alert("Ocorreu um erro ao processar o PDF.");
    } finally {
        processarPDFButton.textContent = "Processar PDF";
        processarPDFButton.disabled = false;
    }
}

// Inicialização: carrega bibliotecas e configura UI
document.addEventListener('DOMContentLoaded', function () {
    const pdfLibUrl = "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js";
    const jspdfUrl = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
    const initialProcessButton = document.getElementById("processarPDF");
    const fileInput = document.getElementById("pdfUpload");

    if (fileInput) fileInput.addEventListener('change', updateFileName);
    else console.error("Input 'pdfUpload' não encontrado!");
    if (initialProcessButton) { initialProcessButton.disabled = true; initialProcessButton.textContent = "Carregando..."; }
    displayLogMessage("Carregando bibliotecas...");

    loadScript(jspdfUrl, () => {
        console.log("jsPDF carregado."); if (typeof window.jspdf?.jsPDF !== 'undefined') { jsPDF = window.jspdf.jsPDF; } else { console.warn("jsPDF não carregado."); }
        loadScript(pdfLibUrl, () => {
            console.log("pdf-lib carregado."); if (typeof window.PDFLib === 'undefined') { console.error("PDFLib não definido."); displayLogMessage("Erro pdf-lib."); if (initialProcessButton) initialProcessButton.disabled = true; return; }
            PDFLib = window.PDFLib;
            if (initialProcessButton) { initialProcessButton.addEventListener("click", processarPdf); initialProcessButton.disabled = false; initialProcessButton.textContent = "Processar PDF"; updateFileName(); }
            else { console.error("Botão 'processarPDF' não encontrado."); }
        }, 'pdf-lib-script');
    }, 'jspdf-script');
});