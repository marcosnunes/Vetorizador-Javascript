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

// Carrega scripts dinamicamente (evita duplicidade)
function loadScript(url, callback, id = null) {
    // Evita carregar script duplicado
    if (id && document.getElementById(id)) {
        console.log(`Script "${id}" já carregado.`);
        if (callback) callback();
        return;
    }

    const script = document.createElement("script");
    script.type = "text/javascript";
    script.src = url;

    if (id) {
        script.id = id;
    }

    script.onload = () => {
        console.log(`Script carregado: ${url}`);
        if (callback) callback();
    };

    script.onerror = () => {
        console.error(`Erro ao carregar o script: ${url}`);
        alert(`Erro ao carregar a biblioteca: ${url}. Verifique a URL e tente novamente.`);
    };

    document.head.appendChild(script);
}

// URL do PDFLib (CDN)
const pdfLibUrl = "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js";

// Carrega PDFLib e inicializa lógica principal
loadScript(pdfLibUrl, () => {
    console.log("PDFLib carregado dinamicamente.");

    // Lógica principal (fora do DOMContentLoaded)
    const fileInput = document.getElementById('pdfUpload');
    const mergePdfButton = document.getElementById('mergePdf');
    const logMessages = document.getElementById('log-messages');
    const pdfDownloadContainer = document.getElementById('pdf-download-container');
    const fileSelectedName = document.getElementById('file-selected-name');

    // Log de status para UI e console
    function displayLogMessage(message) {
        logMessages.textContent = message;
        console.log(message);
    }

    // Seleção de arquivos PDF
    fileInput.addEventListener('change', function () {
        const files = fileInput.files;
        displayLogMessage(`Arquivos selecionados: ${files.length}`);

        // Atualiza o nome dos arquivos selecionados
        if (files.length > 0) {
            fileSelectedName.textContent = `Arquivo(s) selecionado(s): ${files.length}`;
            logMessages.textContent = 'Pronto para processar. Clique em Unir PDFs.';  // Altera a mensagem de log
        } else {
            fileSelectedName.textContent = 'Nenhum arquivo selecionado';
            logMessages.textContent = 'Pronto para processar. Selecione arquivos PDF.'; // Restaura a mensagem inicial
        }
    });

    // Estilo do botão
    mergePdfButton.classList.add('button1');

    mergePdfButton.addEventListener('click', async function () {
        const files = fileInput.files;

        if (!files || files.length === 0) {
            alert('Por favor, selecione pelo menos um arquivo PDF.');
            return;
        }

        displayLogMessage('Iniciando união dos PDFs...');

        try {
            const mergedPdf = await PDFLib.PDFDocument.create();

            for (const file of files) {
                displayLogMessage(`Processando arquivo: ${file.name}`);
                try {
                    const pdfBytes = await file.arrayBuffer();
                    const pdfDoc = await PDFLib.PDFDocument.load(pdfBytes, { ignoreEncryption: true });
                    const copiedPages = await mergedPdf.copyPages(pdfDoc, pdfDoc.getPageIndices());
                    copiedPages.forEach((page) => mergedPdf.addPage(page));
                    displayLogMessage(`Arquivo ${file.name} incorporado com sucesso.`);
                } catch (error) {
                    console.error(`Erro ao processar arquivo ${file.name}:`, error);
                    displayLogMessage(`Erro ao processar arquivo ${file.name}. Verifique o arquivo.`);
                }
            }

            displayLogMessage('PDFs unidos. Criando link para download...');

            try {
                const pdfBytes = await mergedPdf.save();
                const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });
                const pdfUrl = URL.createObjectURL(pdfBlob);

                // Link de download PDF
                let downloadLink = document.createElement('a');
                downloadLink.href = pdfUrl;
                downloadLink.download = 'PDF Unificado.pdf';
                downloadLink.textContent = 'Baixar PDF Unificado';
                downloadLink.classList.add('custom-download-link');

                // Limpa container e adiciona link
                pdfDownloadContainer.innerHTML = '';
                pdfDownloadContainer.appendChild(downloadLink);

                // Foco na área do link
                downloadLink.scrollIntoView({ behavior: 'smooth', block: 'start' });
                displayLogMessage('Pronto! Clique no link para baixar o PDF unificado.');

            } catch (saveError) {
                console.error('Erro ao salvar o PDF unificado:', saveError);
                displayLogMessage('Erro ao salvar o PDF unificado.');
            }

        } catch (error) {
            console.error('Erro ao unir PDFs:', error);
            displayLogMessage(`Erro ao unir PDFs: ${error.message || 'Erro desconhecido'}`);
            alert('Ocorreu um erro ao unir os PDFs. Veja o console para mais detalhes.');
        }
    });

}, 'pdf-lib-script'); // Adiciona um ID para evitar carregamento duplicado