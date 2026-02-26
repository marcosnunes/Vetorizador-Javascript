// Menu lateral (Sidenav)
function openNav() {
    document.getElementById("mySidenav").style.width = "250px";
}

function closeNav() {
    document.getElementById("mySidenav").style.width = "0";
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