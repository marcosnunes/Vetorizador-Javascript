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

// URL da biblioteca PDF.js (CDN)
const pdfjsLibUrl = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";

// Carrega PDF.js e inicializa lógica principal
loadScript(pdfjsLibUrl, () => {
    console.log("PDF.js carregado dinamicamente.");

    // Define worker do PDF.js
    pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js`;

    const fileInput = document.getElementById('pdfUpload');
    const convertPdfButton = document.getElementById('convertPdf');
    const logMessages = document.getElementById('log-messages');
    const thumbnailsContainer = document.getElementById('thumbnails-container');
    const jpgDownloadContainer = document.getElementById('jpg-download-container');
    const fileSelectedName = document.getElementById('file-selected-name');

    // Log de status para UI e console
    function displayLogMessage(message) {
        logMessages.textContent = message;
        console.log(message);
    }

    // Limpa áreas de visualização/download
    function clearPreviousResults() {
        thumbnailsContainer.innerHTML = '';
        jpgDownloadContainer.innerHTML = '';
    }

    // Seleção de arquivo PDF
    fileInput.addEventListener('change', function () {
        clearPreviousResults();
        const file = fileInput.files[0];
        if (file) {
            fileSelectedName.textContent = `Arquivo selecionado: ${file.name}`;
            logMessages.textContent = 'Pronto para converter. Clique no botão "Converter para JPG".';
        } else {
            fileSelectedName.textContent = 'Nenhum arquivo selecionado';
            logMessages.textContent = 'Pronto para processar. Selecione um arquivo PDF.';
        }
    });

    // Conversão PDF → JPG
    convertPdfButton.addEventListener('click', async function () {
        const file = fileInput.files[0];

        if (!file || file.type !== 'application/pdf') {
            alert('Por favor, selecione um arquivo PDF.');
            return;
        }

        clearPreviousResults();
        displayLogMessage('Iniciando a conversão do PDF...');
        convertPdfButton.disabled = true;

        try {
            const reader = new FileReader();
            reader.onload = async function (event) {
                const pdfData = new Uint8Array(event.target.result);
                const pdfDoc = await pdfjsLib.getDocument({ data: pdfData }).promise;

                displayLogMessage(`PDF carregado. Número de páginas: ${pdfDoc.numPages}`);

                for (let i = 1; i <= pdfDoc.numPages; i++) {
                    displayLogMessage(`Convertendo página ${i} de ${pdfDoc.numPages}...`);

                    const page = await pdfDoc.getPage(i);
                    const scale = 1.5; // Escala para qualidade
                    const viewport = page.getViewport({ scale });

                    // Canvas para renderizar página
                    const canvas = document.createElement('canvas');
                    const context = canvas.getContext('2d');
                    canvas.height = viewport.height;
                    canvas.width = viewport.width;

                    // Renderiza página no canvas
                    const renderContext = {
                        canvasContext: context,
                        viewport: viewport
                    };
                    await page.render(renderContext).promise;

                    // Canvas → JPG
                    const jpgUrl = canvas.toDataURL('image/jpeg', 0.9); // 0.9 é a qualidade

                    // Miniatura JPG
                    const img = document.createElement('img');
                    img.src = jpgUrl;
                    thumbnailsContainer.appendChild(img);

                    // Link de download JPG
                    const downloadLink = document.createElement('a');
                    downloadLink.href = jpgUrl;
                    downloadLink.download = `pagina_${i}.jpg`;
                    downloadLink.textContent = `Baixar Página ${i} (JPG)`;
                    downloadLink.classList.add('custom-download-link');
                    jpgDownloadContainer.appendChild(downloadLink);

                    // Quebra de linha para organização
                    jpgDownloadContainer.appendChild(document.createElement('br'));
                }

                displayLogMessage('Conversão concluída! Baixe suas imagens abaixo.');
                jpgDownloadContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });

            };

            reader.onerror = function (error) {
                console.error('Erro ao ler o arquivo PDF:', error);
                displayLogMessage('Erro ao ler o arquivo PDF.');
            };

            reader.readAsArrayBuffer(file);

        } catch (error) {
            console.error('Erro ao converter PDF para JPG:', error);
            displayLogMessage(`Erro ao converter PDF: ${error.message || 'Erro desconhecido'}`);
            alert('Ocorreu um erro ao converter o PDF. Veja o console para mais detalhes.');
        } finally {
            convertPdfButton.disabled = false;
        }
    });

}, 'pdfjs-lib-script');