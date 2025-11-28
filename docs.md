
# Документация по коду проекта **Wombat.js**

Автор: Цай Ариадна Андреевна, группа М3105  
Репозиторий: <https://github.com/tslunaa/wombat-js>

---

## 1. Общая идея и назначение расширения

**Wombat.js** — это учебное расширение для Visual Studio Code, мини-клон Quokka.js.

Расширение:

- запускает текущий JavaScript/TypeScript-файл через **Node.js inspector**;
- получает значения глобальных переменных после выполнения скрипта;
- находит строки объявления этих переменных в открытом файле;
- показывает их значения справа от строки в редакторе в виде **decorations** (подписей);
- позволяет отдельной командой полностью очистить все подписи.

Расширение не изменяет содержимое файла на диске — оно добавляет только визуальные элементы поверх кода.

---

## 2. Структура проекта

Корневая структура репозитория:

- **`.vscode/launch.json`**
- **`node_modules/`**
- **`out/extension.js`**, **`out/extension.js.map`**
- **`src/extension.ts`**
- **`README.md`**
- **`docs.md`** — текущий файл документации
- **`package.json`**
- **`package-lock.json`**
- **`tsconfig.json`**
- **`wombat-js-0.0.1.vsix`**

### 2.1. `.vscode/launch.json`

Файл конфигурации отладчика VS Code.

- **Как появился:** создан автоматически VS Code при выборе команды  
  **“Debug: Open launch.json”** / шаблона *VS Code Extension Development*.
- **Назначение:** описывает конфигурацию запуска расширения в режиме разработки.
- Основные поля (могут немного отличаться по названиям, но смысл такой):

  - `"type": "extensionHost"` — говорит, что запускается отдельный экземпляр VS Code как хост расширения.
  - `"request": "launch"` — тип запуска.
  - `"name": "Run Extension"` — имя конфигурации в списке.
  - `"outFiles": ["${workspaceFolder}/out/**/*.js"]` — куда складываются скомпилированные JS-файлы.
  - `"preLaunchTask": "npm: compile"` — перед запуском выполнить компиляцию TypeScript.

При защите можно сказать:  
*«launch.json описывает, как VS Code запускает моё расширение в отдельном окне Extension Development Host и откуда брать скомпилированный код.»*

---

### 2.2. `node_modules/`

Каталог с зависимостями npm.

- **Как появился:** создаётся автоматически командой:

```bash
  npm install
````

* **Содержит:**

  * сам Visual Studio Code API (типовые определения),
  * TypeScript-компилятор,
  * вспомогательные библиотеки, которые используются генератором расширений.


---

### 2.3. `src/extension.ts` — основной исходный код расширения

Это главный файл проекта. Именно его компилирует TypeScript, и он подключается как `main` в `package.json`.

Файл был создан генератором расширения VS Code (`yo code` / команда **“New Extension (TypeScript)”**), а затем доработан под задачу Wombat.js.

#### Основная структура файла

Типичный скелет:

```ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as util from 'util';
import * as inspector from 'inspector';

// Глобальные переменные для хранения состояния
let session: inspector.Session | null = null;
let post: ((method: string, params?: any) => Promise<any>) | null = null;
let decorationTypes: vscode.TextEditorDecorationType[] = [];

// Точка входа расширения
export async function activate(context: vscode.ExtensionContext) {
  // ...
}

export function deactivate() {
  // ...
}
```

Ниже разбираем по функциям и логике.

---

#### 2.3.1. `activate(context: vscode.ExtensionContext)`

**Назначение:** точка входа расширения, вызывается VS Code при активации.

Основные шаги (логика):

1. **Запуск Node.js inspector**

   ```ts
   inspector.open();
   session = new inspector.Session();
   session.connect();
   post = util.promisify(session.post).bind(session) as any;
   ```

   * `inspector.open()` — запуск встроенного инспектора, аналог `node --inspect file.js`.
   * `Session` — объект, через который мы отправляем команды в Node (компиляция скрипта, выполнение, получение переменных).
   * Обёртка `post` через `util.promisify` — позволяет использовать `async/await` вместо callback-API.

2. **Регистрация команды «запустить текущий файл»**

   В `activate` регистрируется команда, имя которой указано в `package.json` (например, `wombat.runCurrentFile`):

   ```ts
   const runCommand = vscode.commands.registerCommand(
     'wombat.runCurrentFile',
     async () => {
       await runCurrentFile();
     }
   );
   context.subscriptions.push(runCommand);
   ```

   * `vscode.commands.registerCommand` связывает идентификатор команды с функцией-обработчиком.
   * `context.subscriptions.push(...)` — VS Code потом сам освободит ресурсы при деактивации расширения.

3. **Регистрация команды «очистить все decorations»**

   Аналогично регистрируется команда (например, `wombat.clearDecorations`):

   ```ts
   const clearCommand = vscode.commands.registerCommand(
     'wombat.clearDecorations',
     () => clearAllDecorations()
   );
   context.subscriptions.push(clearCommand);
   ```

   Она не запускает inspector, а только очищает визуальные подписи в текущем редакторе.


#### 2.3.2. `deactivate()`

**Назначение:** вызывается, когда расширение выгружается.

Типичный функционал:

```ts
export function deactivate() {
  if (session) {
    session.disconnect();
    session = null;
    post = null;
  }
  clearAllDecorations();
}
```

* Отключает сессию inspector.
* Чистит все decorations.
* Обнуляет ссылки, чтобы не было утечек памяти.


---

#### 2.3.3. Обработчик `runCurrentFile()`

Функция (может быть объявлена как внутренняя `async function runCurrentFile()` в `extension.ts`), которая выполняется при команде **Run current file**.

Логика по шагам:

1. **Получить активный редактор и путь к файлу**

   ```ts
   const editor = vscode.window.activeTextEditor;
   if (!editor) {
     vscode.window.showErrorMessage('Нет активного редактора');
     return;
   }

   const document = editor.document;
   const fileName = document.fileName;
   ```

2. **Сохранить файл (при необходимости)**

   Обычно запускают `document.save()`, чтобы выполнять актуальную версию кода.

3. **Компиляция и выполнение скрипта через inspector**

   Примерная логика (названия методов могут отличаться, но идея такая):

   ```ts
   // 1. Runtime.enable
   await post!('Runtime.enable');

   // 2. Прочитать содержимое файла
   const source = document.getText();

   // 3. Runtime.compileScript
   const { scriptId } = await post!('Runtime.compileScript', {
     expression: source,
     sourceURL: fileName,
     persistScript: true
   });

   // 4. Runtime.runScript
   await post!('Runtime.runScript', { scriptId, executionContextId: 1 });
   ```

   Здесь мы говорим Node-у: «скачай этот текст как скрипт и выполни его».

4. **Получить список глобальных переменных**

   Один из вариантов — запросить глобальный объект и обойти его свойства:

   ```ts
   const globalObject = await post!('Runtime.evaluate', {
     expression: 'this',
     contextId: 1,
     returnByValue: false
   });

   // Далее — обход свойств через Runtime.getProperties
   ```

   В итоге формируется массив структур вида:

   ```ts
   interface VariableInfo {
     name: string;
     value: string; // строковое представление значения
   }
   ```

5. **Найти строки объявления переменных**

   Для каждого имени ищется строка в документе. Типично:

   * пробегаем по всем строкам `for (let line = 0; line < document.lineCount; line++)`;
   * проверяем, содержит ли строка шаблон `const <name>`, `let <name>` или `var <name>`;
   * сохраняем позицию конца строки: `const position = new vscode.Position(line, textLine.range.end.character);`.

6. **Создать decorations с подписями**

   Сначала создаётся тип оформления (цвет, отступ справа):

   ```ts
   const decorationType = vscode.window.createTextEditorDecorationType({
     after: {
       margin: '0 0 0 1rem',
       color: '#888'
     }
   });
   decorationTypes.push(decorationType);
   ```

   Затем формируется массив опций:

   ```ts
   const decorations: vscode.DecorationOptions[] = [];

   for (const variable of variables) {
     const line = findLineOf(variable.name);
     if (line === undefined) continue;

     const lineEnd = document.lineAt(line).range.end;

     decorations.push({
       range: new vscode.Range(lineEnd, lineEnd),
       renderOptions: {
         after: {
           contentText: ` ${variable.name} = ${variable.value}`
         }
       }
     });
   }

   editor.setDecorations(decorationType, decorations);
   ```

**Итог:** возле каждой строки с объявлением переменной появляется подпись вида:

```txt
const a = 5;      a = 5
let b = a * 3;    b = 15
```

---

#### 2.3.4. `clearAllDecorations()`

Отдельная функция/команда для очистки результата.

Примерная реализация:

```ts
function clearAllDecorations() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  for (const type of decorationTypes) {
    editor.setDecorations(type, []);
    type.dispose();
  }

  decorationTypes = [];
}
```

* **`editor.setDecorations(type, [])`** — убирает конкретный тип оформления из документа.
* **`type.dispose()`** — освобождает ресурсы, связанные с DecorationType.
* После этого массив `decorationTypes` очищается.


---

### 2.4. `out/extension.js` и `out/extension.js.map`

* **Как появились:** генерируются компилятором TypeScript командой:

  ```bash
  npm run compile
  # или
  npx tsc
  ```

* `extension.js` — скомпилированная версия `src/extension.ts`.

* `extension.js.map` — source-map, который позволяет отладчику показывать исходный TypeScript-код при отладке.

В `launch.json` VS Code запускает именно `out/extension.js`.

---

### 2.5. `README.md`

Файл с общим описанием проекта (ты его уже заполнила):

* кратко описывает идею Wombat.js,
* перечисляет основные возможности,
* объясняет, как установить и запустить расширение.

---

### 2.6. `docs.md`

Этот файл — **подробная документация по коду**.

Здесь описываются:

* архитектура;
* структура проекта;
* назначение файлов;
* описание основных функций и команд;
* примеры запуска и установки.

Именно его обычно прикладывают к отчёту по лабораторной работе.

---

### 2.7. `package.json`

Конфигурация npm-проекта и VS Code-расширения.

**Как появился:** сгенерирован при создании проекта (`yo code` / “New Extension (TypeScript)”), затем отредактирован.

Основные поля (по смыслу):

* `"name": "wombat-js"` — системное имя расширения.

* `"displayName": "Wombat.js"` — имя, показываемое в VS Code.

* `"description"` — краткое описание (мини-клон Quokka).

* `"version": "0.0.1"` — версия расширения.

* `"publisher"` — издатель (обычно совпадает с логином на marketplace).

* `"engines": { "vscode": "^1.80.0" }` — минимальная версия VS Code.

* `"categories": ["Other"]` — категория в marketplace.

* `"main": "./out/extension.js"` — точка входа при запуске расширения.

* `"scripts"`:

  * `"vscode:prepublish": "npm run compile"` — компиляция перед публикацией;
  * `"compile": "tsc -p ."` — компиляция TypeScript;
  * `"watch": "tsc -watch -p ."` — компиляция при изменении файлов;
  * `"test": "node ./out/test/runTest.js"` — тесты (если подключены).

* `"contributes"`:

  * `"commands"` — список команд, видимых в палитре команд VS Code. Пример:

    ```json
    "contributes": {
      "commands": [
        {
          "command": "wombat.runCurrentFile",
          "title": "Wombat: Run current file"
        },
        {
          "command": "wombat.clearDecorations",
          "title": "Wombat: Clear decorations"
        }
      ]
    }
    ```

Именно здесь задаются идентификаторы команд, которыми потом пользуется `extension.ts`.

---

### 2.8. `package-lock.json`

Фиксация точных версий всех зависимостей npm.

* **Как появился:** автоматически создаётся npm при первом `npm install`.
* **Назначение:** гарантировать, что у всех пользователей/проверяющих будет одинаковое дерево зависимостей.

---

### 2.9. `tsconfig.json`

Конфигурация TypeScript.

**Как появился:** сгенерирован шаблоном расширения VS Code.

Типовое содержимое:

* `"compilerOptions"`:

  * `"module": "commonjs"` — формат модулей, совместимый с Node.js.
  * `"target": "es6"` — версия JavaScript после компиляции.
  * `"outDir": "./out"` — директория, куда складывать скомпилированные JS-файлы.
  * `"lib": ["es6"]` — какие стандартные библиотеки подключены.
  * `"sourceMap": true` — генерировать `.map`-файлы.
  * `"strict": true` — строгий режим TypeScript.
* `"include": ["src"]` — какие каталоги компилировать.


---

### 2.10. `wombat-js-0.0.1.vsix`

Готовый пакет расширения для установки в VS Code.

* **Как появился:** собран командой:

  ```bash
  vsce package
  ```

  или через встроенную команду VS Code “VSIX: Create VSIX Package” (в зависимости от того, как ты упаковывала).

* **Использование:** устанавливается в VS Code через:

  * **Extensions → … → Install from VSIX…**
    и выбор файла `wombat-js-0.0.1.vsix`.

---

## 3. Сборка и запуск проекта

### 3.1. Установка зависимостей

```bash
git clone https://github.com/tslunaa/wombat-js
cd wombat-js
npm install
```

### 3.2. Компиляция TypeScript

```bash
npm run compile
# или просто
npx tsc
```

После этого в каталоге `out/` появится `extension.js`.

### 3.3. Запуск в режиме разработки

1. Открыть проект в VS Code.
2. Нажать **F5** (или выбрать конфигурацию `Run Extension` в Run and Debug).
3. Откроется второе окно **Extension Development Host** — в нём и тестируется расширение.

---

## 4. Использование расширения

### 4.1. Запуск файла и вывод значений

1. Открыть в окне Extension Development Host любой файл `*.js` или `*.ts`.

2. Вызвать команду:

   * через Command Palette (**Ctrl+Shift+P** / **Cmd+Shift+P**)
     и выбрать **“Wombat: Run current file”**,
   * или через биндинг, если он настроен.

3. Расширение:

   * запускает Node inspector;
   * выполняет текущий файл;
   * получает список глобальных переменных и их значения;
   * ищет строки объявления этих переменных в документе;
   * добавляет справа от строки подпосибиры вида `x = 42`.

### 4.2. Очистка всех подписей

1. В том же файле вызвать команду:

   * **“Wombat: Clear decorations”**.

2. Все добавленные подписи исчезнут, а связанные с ними `DecorationType` будут освобождены.

---

* **Архитектура:**
  Один основной модуль `src/extension.ts`, который:

  * при активации запускает inspector, создаёт сессию и регистрирует команды;
  * по команде `Run current file` выполняет скрипт, получает глобальные переменные и рисует decorations;
  * по команде `Clear decorations` очищает все ранее созданные decorations;
  * при деактивации закрывает сессию и освобождает ресурсы.

* **Файлы конфигурации:**
  `package.json` — описание расширения (команды, скрипты, точка входа);
  `tsconfig.json` — правила компиляции TypeScript;
  `.vscode/launch.json` — конфигурация запуска для отладки;
  `package-lock.json` и `node_modules/` — инфраструктура npm.

* **Сборка и запуск:**
  `npm install` → `npm run compile` → **F5** для запуска в Extension Development Host
  либо упаковка в `wombat-js-0.0.1.vsix` и установка в обычный VS Code.

