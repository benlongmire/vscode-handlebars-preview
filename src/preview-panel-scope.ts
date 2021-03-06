import { WebviewPanel, TextEditor, TextDocumentChangeEvent, ViewColumn, Uri, workspace, window, FileSystemWatcher, ExtensionContext, TextDocument } from 'vscode';
import { promises, existsSync } from 'fs';
import { load as loadDocument } from "cheerio";
import * as path from "path";
import { compile, TemplateDelegate } from 'handlebars';
import { showErrorMessage } from "./extension";

export class PreviewPanelScope {
    private readonly contextWatcher: FileSystemWatcher;
    private readonly panel: WebviewPanel;
    private readonly contextFileName: string;

    constructor(private readonly document: TextDocument, onPreviewPanelClosed: (panel: PreviewPanelScope) => void) {
        const contextFileName = getContextFileName(document.fileName);

        this.contextFileName = contextFileName;

        this.panel = window.createWebviewPanel("preview", `Preview: ${path.basename(document.fileName)}`, ViewColumn.Two, {
            localResourceRoots: workspace.workspaceFolders!.map(p => p.uri).concat(Uri.file(path.dirname(document.fileName)))
        });

        this.panel.onDidDispose(() => {
            this.contextWatcher.dispose();
            onPreviewPanelClosed(this);
        });

        this.contextWatcher = workspace.createFileSystemWatcher(contextFileName);
        this.contextWatcher.onDidChange(e => {
            getCompiledHtml(this.document, this.contextFileName, this).then(html => {
                if (html) {
                    this.panel.webview.html = html;
                }
            });
        });
    }

    editorFilePath() {
        return this.document.uri.fsPath;
    }

    async update() {
        const html = await getCompiledHtml(this.document, this.contextFileName, this);

        if (html) {
            this.panel.webview.html = html;
        }
    }

    showErrorPage(message: string) {
        this.panel.webview.html = `
        <html style="height: 100%;">
        <body style="height: 100%; display: flex; align-items: center; align-content: center; justify-content: center;"><span>${message}</span></body>
        </html>
        `;
    }

    disposePreviewPanel() {
        this.panel.dispose();
    }

    async workspaceDocumentChanged(event: TextDocumentChangeEvent) {
        if (event.document === this.document || event.document.fileName === this.contextFileName) {
            await this.update();
        }
    }
}

function getContextFileName(templateFileName: string): string {
    const contextFileName = `${templateFileName}.json`;

    if (!existsSync(contextFileName)) {
        window.showInformationMessage(`Tip: create a file named ${path.basename(contextFileName)} with your test data`);
    }

    return contextFileName;
}

function renderTemplate(template: TemplateDelegate, templateContext, panel: PreviewPanelScope) {
    try {
        const html = template(templateContext);

        showErrorMessage.next(null);

        return html;
    } catch (err) {
        showErrorMessage.next({ panel: panel, message: `Error rendering handlebars template: ${JSON.stringify(err)}` });
        return false;
    }
}

async function getCompiledHtml(templateDocument: TextDocument, contextFile: string, panel: PreviewPanelScope): Promise<string | false> {
    const context = await getContextData(contextFile);
    const template = templateDocument.getText();

    try {
        const compiledTemplate = compile(template);
        const rendered = renderTemplate(compiledTemplate, context, panel);
        
        if (rendered === false) {
            return false;
        }

        return repathImages(rendered || '', templateDocument);

    } catch (err) {
        showErrorMessage.next({ panel: panel, message: `Error rendering handlebars template: ${JSON.stringify(err)}` });
        return false;
    }
}

async function getContextData(contextFile: string) {
    try {
        var contextJson = await promises.readFile(contextFile, 'utf8');
        return JSON.parse(contextJson);
    } catch (err) {
        return {};
    }
}

function repathImages(html: string, templateDocument: TextDocument) {
    const $ = loadDocument(html);

    $('img')
        .filter((i, elm) => 
            // Skip data-urls
            elm.attribs['src'].trimLeft().slice(0, 5).toLowerCase() !== 'data:' &&
            // Skip remote images
            !elm.attribs['src'].toLowerCase().startsWith('http')
        )
        .each((index, element) => {
            const newSrc = templateDocument.uri.with({
                scheme: 'vscode-resource',
                path: path.join(path.dirname(templateDocument.fileName), element.attribs['src']),
            }).toString();
            element.attribs['src'] = newSrc;
        });

    const repathedHtml = $.html({
        decodeEntities: true
    });

    return repathedHtml;
}
