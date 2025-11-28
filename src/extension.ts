import * as vscode from "vscode";
import * as path from "path";
import * as util from "util";
import * as inspector from "inspector";

/*
  Массив со всеми созданными декорациями.
  Нужен, чтобы потом можно было их удалить (dispose) при очистке.
 */
const allDecorations: vscode.TextEditorDecorationType[] = [];

/*
  Класс-обёртка над Node.js Inspector API.
  
  Отвечает за:
   - запуск и завершение инспектор-сессии;
   - включение Runtime/Debugger;
   - компиляцию и запуск скрипта;
   - получение глобальных переменных;
   - вычисление выражений в контексте исполняемого скрипта;
   - поиск в тексте скрипта.
 */
class InspectorClient {
  /* Активная сессия Inspector. */
  private session: inspector.Session;

  /*
    Асинхронная обёртка над session.post,
    чтобы вызывать Inspector API через промисы.
   */
  private postFn: (method: string, params?: any) => Promise<any>;

  constructor() {
    // Создаём новую сессию инспектора и подключаемся к ней.
    this.session = new inspector.Session();
    this.session.connect();

    // Превращаем callback-ориентированный session.post в функцию, возвращающую промис.
    this.postFn = util.promisify(
      this.session.post.bind(this.session) as (
        method: string,
        params?: any,
        callback?: (err: Error | null, result?: any) => void
      ) => void
    );
  }

  /*
    Включает подсистемы Runtime и Debugger в инспекторе.
    Обязательно вызывать до остальных операций (compile, run и т.д.).
   */
  async enableRuntime(): Promise<void> {
    await this.postFn("Runtime.enable");
    await this.postFn("Debugger.enable");
  }

  /*
    Компилирует переданный код как скрипт в Inspector Runtime.
   
    @param code     исходный код файла целиком
    @param fileName имя файла (используется как sourceURL)
    @returns        идентификатор скомпилированного скрипта (scriptId)
   */
  async compileScript(code: string, fileName: string): Promise<string> {
    const { scriptId } = await this.postFn("Runtime.compileScript", {
      expression: code,
      sourceURL: fileName,
      persistScript: true
    });
    return scriptId;
  }

  /*
    Запускает ранее скомпилированный скрипт.
   
    @param scriptId идентификатор скрипта, полученный из compileScript
   */
  async runScript(scriptId: string): Promise<void> {
    await this.postFn("Runtime.runScript", { scriptId });
  }

  /*
    Возвращает имена всех глобальных лексических переменных
    в контексте выполнения (executionContextId = 1).
   
    @returns массив имён глобальных переменных
   */
  async getGlobalNames(): Promise<string[]> {
    const data = await this.postFn("Runtime.globalLexicalScopeNames", {
      executionContextId: 1
    });
    return (data.names || []) as string[];
  }

  /*
    Выполняет произвольное выражение в контексте скрипта.
    Используется для получения значений глобальных переменных.
   
    @param expression строковое выражение (например, имя переменной)
    @returns значение, которое вернуло выражение (result.value)
   */
  async evaluate(expression: string): Promise<any> {
    const result = await this.postFn("Runtime.evaluate", {
      expression,
      contextId: 1
    });
    return result?.result?.value;
  }

  /*
    Ищет строку с указанным запросом в тексте скрипта.
   
    @param scriptId идентификатор скрипта
    @param query    искомая подстрока
    @returns        первый найденный матч с номером строки и её содержимым
                    либо null, если совпадений нет
   */
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

  /*
    Корректно завершает инспектор-сессию.
    Вызывается в блоке finally, чтобы освободить ресурсы
    даже при ошибках во время работы.
   */
  close(): void {
    try {
      this.session.disconnect();
    } catch {
      // Игнорируем возможные ошибки при закрытии сессии.
    }
  }
}

/*
  Добавляет текстовую декорацию в редактор на указанной позиции.
  
  Декорация отображается как текст "после" (after) конца строки:
    <строка кода>  ⟶  <contentText>
 
  @param contentText текст, который будет показан после строки
  @param line        номер строки (0-based)
  @param column      позиция внутри строки, к которой привязать декорацию
  @param editor      редактор, в котором нужно отрисовать декорацию
 */
function addDecorationWithText(
  contentText: string,
  line: number,
  column: number,
  editor: vscode.TextEditor
): void {
  // Создаём тип декорации: добавляем текст после позиции курсора.
  const decorationType = vscode.window.createTextEditorDecorationType({
    after: {
      contentText,
      margin: "  ⟶  ",
      fontStyle: "italic"
    }
  });

  // Сохраняем декорацию, чтобы потом её можно было удалить.
  allDecorations.push(decorationType);

  // Диапазон нулевой длины – просто позиция (line, column).
  const range = new vscode.Range(
    new vscode.Position(line, column),
    new vscode.Position(line, column)
  );

  // Применяем созданную декорацию к указанному диапазону.
  editor.setDecorations(decorationType, [{ range }]);
}

/*
 Основная команда расширения:
  - берёт код из активного редактора;
  - запускает его через Node.js Inspector;
  - находит глобальные переменные;
  - вычисляет их значения;
  - добавляет к строкам с объявлениями декорации вида:
        myVar = 42
 */
async function runWombatCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("Нет активного редактора.");
    return;
  }

  const document = editor.document;

  // Расширение работает только с JS/TS-файлами.
  if (
    document.languageId !== "javascript" &&
    document.languageId !== "typescript"
  ) {
    vscode.window.showWarningMessage(
      "Wombat работает только с JavaScript/TypeScript-файлами."
    );
    return;
  }

  // Получаем текст документа и имя файла для передачи в инспектор.
  const code = document.getText();
  const fileName = path.basename(
    document.uri.fsPath || document.uri.toString()
  );

  // Создаём клиента Inspector для работы с Node.js Runtime.
  const client = new InspectorClient();

  try {
    // Включаем Runtime и Debugger.
    await client.enableRuntime();

    // Компилируем и запускаем текущий скрипт.
    const scriptId = await client.compileScript(code, fileName);
    await client.runScript(scriptId);

    // Получаем имена глобальных переменных.
    const names = await client.getGlobalNames();
    if (!names.length) {
      vscode.window.showInformationMessage(
        "Глобальных переменных не найдено."
      );
      return;
    }

    // Для каждой глобальной переменной:
    for (const name of names) {
      try {
        // 1) узнаём её значение через Runtime.evaluate
        const value = await client.evaluate(name);

        // 2) ищем строку в скрипте, где встречается это имя
        const location = await client.searchInScript(scriptId, name);
        if (!location) {
          continue;
        }

        const lineNumber = location.lineNumber;
        const lineText = document.lineAt(lineNumber).text;

        // Ставим декорацию в конец строки.
        const column = lineText.length;

        // 3) добавляем визуальную подсказку в редактор:
        //    "<имя> = <значение>"
        addDecorationWithText(
          `${name} = ${String(value)}`,
          lineNumber,
          column,
          editor
        );
      } catch (e) {
        // Ошибка для конкретной переменной не ломает обработку остальных.
        console.error(`Failed to decorate ${name}`, e);
      }
    }
  } catch (e: any) {
    // Любые "глобальные" ошибки работы команды – показываем пользователю.
    console.error(e);
    vscode.window.showErrorMessage(
      `Ошибка при выполнении файла через Wombат: ${e?.message || e}`
    );
  } finally {
    // В любом случае закрываем инспектор-сессию.
    client.close();
  }
}

/*
  Удаляет все ранее созданные декорации из редактора
  и очищает массив allDecorations.
  
  Используется при явной очистке пользователем и при деактивации расширения.
 */
function clearAllDecorations() {
  for (const deco of allDecorations) {
    deco.dispose();
  }
  allDecorations.length = 0;
}

/*
  Точка входа расширения VS Code.
  
  Вызывается VS Code при активации расширения.
  Здесь регистрируются команды и добавляются подписки на события.
 
  @param context контекст расширения, предоставляет API для регистрации команд
 */
export function activate(context: vscode.ExtensionContext) {
  console.log("Wombat.js extension is now active.");

  /*
    Команда wombat.runFile:
    запускает текущий файл и добавляет декорации с глобальными переменными.
   */
  const runCmd = vscode.commands.registerCommand(
    "wombat.runFile",
    async () => {
      await runWombatCommand();
    }
  );

  /*
    Команда wombat.clearDecorations:
    очищает все добавленные расширением декорации.
   */
  const clearCmd = vscode.commands.registerCommand(
    "wombat.clearDecorations",
    () => {
      clearAllDecorations();
      vscode.window.showInformationMessage("Wombat: Decorations cleared.");
    }
  );

  // Добавляем команды в список подписок,
  // чтобы VS Code автоматически их очистил при деактивации расширения.
  context.subscriptions.push(runCmd, clearCmd);
}

/*
  Вызывается VS Code при деактивации расширения.
  Здесь можно освободить ресурсы и удалить побочные эффекты.
 */
export function deactivate() {
  console.log("Wombat.js extension deactivated.");
  clearAllDecorations();
}
