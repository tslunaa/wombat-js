import * as vscode from "vscode";
import * as path from "path";
import * as util from "util";
import * as inspector from "inspector";

const allDecorations: vscode.TextEditorDecorationType[] = [];

class InspectorClient {
  private session: inspector.Session;
  private postFn: (method: string, params?: any) => Promise<any>;

  constructor() {

    this.session = new inspector.Session();
    this.session.connect();

    this.postFn = util.promisify(
      this.session.post.bind(this.session) as (
        method: string,
        params?: any,
        callback?: (err: Error | null, result?: any) => void
      ) => void
    );
  }

  async enableRuntime(): Promise<void> {
    await this.postFn("Runtime.enable");
    await this.postFn("Debugger.enable");
  }

  async compileScript(code: string, fileName: string): Promise<string> {
    const { scriptId } = await this.postFn("Runtime.compileScript", {
      expression: code,
      sourceURL: fileName,
      persistScript: true
    });
    return scriptId;
  }

  async runScript(scriptId: string): Promise<void> {
    await this.postFn("Runtime.runScript", { scriptId });
  }

  async getGlobalNames(): Promise<string[]> {
    const data = await this.postFn("Runtime.globalLexicalScopeNames", {
      executionContextId: 1
    });
    return (data.names || []) as string[];
  }

  async evaluate(expression: string): Promise<any> {
    const result = await this.postFn("Runtime.evaluate", {
      expression,
      contextId: 1
    });
    return result?.result?.value;
  }

  async searchInScript(
    scriptId: string,
    query: string
  ): Promise<{ lineNumber: number; lineContent: string } | null> {
    const data = await this.postFn("Debugger.searchInContent", {
      scriptId,
      query
    });

    const matches = (data.result || []) as Array<{
      lineNumber: number;
      lineContent: string;
    }>;

    if (!matches.length) {
      return null;
    }
    return matches[0];
  }

  close(): void {
    try {
      this.session.disconnect();
    } catch {

    }

  }
}

function addDecorationWithText(
  contentText: string,
  line: number,
  column: number,
  editor: vscode.TextEditor
): void {
  const decorationType = vscode.window.createTextEditorDecorationType({
    after: {
      contentText,
      margin: "  ⟶  ",
      fontStyle: "italic"
    }
  });

  allDecorations.push(decorationType);

  const range = new vscode.Range(
    new vscode.Position(line, column),
    new vscode.Position(line, column)
  );

  editor.setDecorations(decorationType, [{ range }]);
}

async function runWombatCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("Нет активного редактора.");
    return;
  }

  const document = editor.document;

  if (
    document.languageId !== "javascript" &&
    document.languageId !== "typescript"
  ) {
    vscode.window.showWarningMessage(
      "Wombat работает только с JavaScript/TypeScript-файлами."
    );
    return;
  }

  const code = document.getText();
  const fileName = path.basename(
    document.uri.fsPath || document.uri.toString()
  );

  const client = new InspectorClient();

  try {
    await client.enableRuntime();

    const scriptId = await client.compileScript(code, fileName);
    await client.runScript(scriptId);

    const names = await client.getGlobalNames();
    if (!names.length) {
      vscode.window.showInformationMessage(
        "Глобальных переменных не найдено."
      );
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

        addDecorationWithText(
          `${name} = ${String(value)}`,
          lineNumber,
          column,
          editor
        );
      } catch (e) {
        console.error(`Failed to decorate ${name}`, e);
      }
    }
  } catch (e: any) {
    console.error(e);
    vscode.window.showErrorMessage(
      `Ошибка при выполнении файла через Wombat: ${e?.message || e}`
    );
  } finally {
    client.close();
  }
}

function clearAllDecorations() {
  for (const deco of allDecorations) {
    deco.dispose();
  }
  allDecorations.length = 0;
}

export function activate(context: vscode.ExtensionContext) {
  console.log("Wombat.js extension is now active.");

  const runCmd = vscode.commands.registerCommand(
    "wombat.runFile",
    async () => {
      await runWombatCommand();
    }
  );

  const clearCmd = vscode.commands.registerCommand(
    "wombat.clearDecorations",
    () => {
      clearAllDecorations();
      vscode.window.showInformationMessage("Wombat: Decorations cleared.");
    }
  );

  context.subscriptions.push(runCmd, clearCmd);
}

export function deactivate() {
  console.log("Wombat.js extension deactivated.");
  clearAllDecorations();
}
