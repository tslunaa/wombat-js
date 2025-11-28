"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const util = __importStar(require("util"));
const inspector = __importStar(require("inspector"));
const allDecorations = [];
class InspectorClient {
    constructor() {
        this.session = new inspector.Session();
        this.session.connect();
        this.postFn = util.promisify(this.session.post.bind(this.session));
    }
    async enableRuntime() {
        await this.postFn("Runtime.enable");
        await this.postFn("Debugger.enable");
    }
    async compileScript(code, fileName) {
        const { scriptId } = await this.postFn("Runtime.compileScript", {
            expression: code,
            sourceURL: fileName,
            persistScript: true
        });
        return scriptId;
    }
    async runScript(scriptId) {
        await this.postFn("Runtime.runScript", { scriptId });
    }
    async getGlobalNames() {
        const data = await this.postFn("Runtime.globalLexicalScopeNames", {
            executionContextId: 1
        });
        return (data.names || []);
    }
    async evaluate(expression) {
        var _a;
        const result = await this.postFn("Runtime.evaluate", {
            expression,
            contextId: 1
        });
        return (_a = result === null || result === void 0 ? void 0 : result.result) === null || _a === void 0 ? void 0 : _a.value;
    }
    async searchInScript(scriptId, query) {
        const data = await this.postFn("Debugger.searchInContent", {
            scriptId,
            query
        });
        const matches = (data.result || []);
        if (!matches.length) {
            return null;
        }
        return matches[0];
    }
    close() {
        try {
            this.session.disconnect();
        }
        catch {
        }
    }
}
function addDecorationWithText(contentText, line, column, editor) {
    const decorationType = vscode.window.createTextEditorDecorationType({
        after: {
            contentText,
            margin: "  ⟶  ",
            fontStyle: "italic"
        }
    });
    allDecorations.push(decorationType);
    const range = new vscode.Range(new vscode.Position(line, column), new vscode.Position(line, column));
    editor.setDecorations(decorationType, [{ range }]);
}
async function runWombatCommand() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage("Нет активного редактора.");
        return;
    }
    const document = editor.document;
    if (document.languageId !== "javascript" &&
        document.languageId !== "typescript") {
        vscode.window.showWarningMessage("Wombat работает только с JavaScript/TypeScript-файлами.");
        return;
    }
    const code = document.getText();
    const fileName = path.basename(document.uri.fsPath || document.uri.toString());
    const client = new InspectorClient();
    try {
        await client.enableRuntime();
        const scriptId = await client.compileScript(code, fileName);
        await client.runScript(scriptId);
        const names = await client.getGlobalNames();
        if (!names.length) {
            vscode.window.showInformationMessage("Глобальных переменных не найдено.");
            return;
        }
        for (const name of names) {
            try {
                const value = await client.evaluate(name);
                const location = await client.searchInScript(scriptId, name);
                if (!location) {
                    continue;
                }
                const lineNumber = location.lineNumber;
                const lineText = document.lineAt(lineNumber).text;
                const column = lineText.length;
                addDecorationWithText(`${name} = ${String(value)}`, lineNumber, column, editor);
            }
            catch (e) {
                console.error(`Failed to decorate ${name}`, e);
            }
        }
    }
    catch (e) {
        console.error(e);
        vscode.window.showErrorMessage(`Ошибка при выполнении файла через Wombat: ${(e === null || e === void 0 ? void 0 : e.message) || e}`);
    }
    finally {
        client.close();
    }
}
function clearAllDecorations() {
    for (const deco of allDecorations) {
        deco.dispose();
    }
    allDecorations.length = 0;
}
function activate(context) {
    console.log("Wombat.js extension is now active.");
    const runCmd = vscode.commands.registerCommand("wombat.runFile", async () => {
        await runWombatCommand();
    });
    const clearCmd = vscode.commands.registerCommand("wombat.clearDecorations", () => {
        clearAllDecorations();
        vscode.window.showInformationMessage("Wombat: Decorations cleared.");
    });
    context.subscriptions.push(runCmd, clearCmd);
}
function deactivate() {
    console.log("Wombat.js extension deactivated.");
    clearAllDecorations();
}
//# sourceMappingURL=extension.js.map