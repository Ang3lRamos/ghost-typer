const vscode = require('vscode');

// Cada proveedor sabe armar su petición y traducir sus eventos a { text, stopReason }.
const PROVIDERS = {
  anthropic: {
    label: 'Anthropic',
    secret: 'ghostTyper.anthropicApiKey',
    url: 'https://api.anthropic.com/v1/messages',
    headers: (apiKey) => ({ 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }),
    modelSetting: 'model',
    body: (config, system, problem) => ({
      model: config.get('model'),
      max_tokens: 16000,
      stream: true,
      output_config: { effort: config.get('effort') },
      system,
      messages: [{ role: 'user', content: problem }],
    }),
    parse(message) {
      if (message.type === 'error') throw new Error(message.error.message);
      if (message.type === 'content_block_delta' && message.delta.type === 'text_delta') {
        return { text: message.delta.text };
      }
      if (message.type === 'message_delta') return { stopReason: message.delta.stop_reason };
      return {};
    },
  },
  openrouter: openAICompatible('OpenRouter', 'openrouter', 'https://openrouter.ai/api/v1/chat/completions'),
  groq: openAICompatible('Groq', 'groq', 'https://api.groq.com/openai/v1/chat/completions'),
};

// OpenRouter y Groq usan el formato de chat completions de OpenAI.
function openAICompatible(label, id, url) {
  const modelSetting = `${id}Model`;
  return {
    label,
    secret: `ghostTyper.${id}ApiKey`,
    url,
    headers: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
    modelSetting,
    body: (config, system, problem) => ({
      model: config.get(modelSetting),
      stream: true,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: problem },
      ],
    }),
    parse(message) {
      if (message.error) throw new Error(message.error.message);
      const choice = message.choices?.[0];
      const stopReason = { length: 'max_tokens', content_filter: 'refusal' }[choice?.finish_reason];
      return { text: choice?.delta?.content, stopReason };
    },
  };
}
const RELEASE_AFTER_QUIET_MS = 1500;
const EDIT_ATTEMPTS = 10;
const COMMENT_PREFIX =/^\s*(\/\/+|#+|--+|\/\*+|\*+\/?|"""|''')\s?/;

let session = null;
let statusBar;

function activate(context) {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  context.subscriptions.push(
    statusBar,
    vscode.commands.registerCommand('ghostTyper.start', () => start(context)),
    vscode.commands.registerCommand('ghostTyper.stop', stop),
    vscode.commands.registerCommand('ghostTyper.setApiKey', () => askApiKey(context, currentProvider())),
    { dispose: stop }
  );
}

function currentProvider() {
  return PROVIDERS[vscode.workspace.getConfiguration('ghostTyper').get('provider')];
}

async function askApiKey(context, provider) {
  const key = await vscode.window.showInputBox({
    prompt: `API key de ${provider.label} (se guarda en el almacén seguro de VS Code)`,
    password: true,
    ignoreFocusOut: true,
  });
  if (key) await context.secrets.store(provider.secret, key.trim());
  return key?.trim();
}

async function start(context) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  stop();

  const provider = currentProvider();
  if (!vscode.workspace.getConfiguration('ghostTyper').get(provider.modelSetting)) {
    vscode.window.showWarningMessage(`Ghost Typer: falta elegir el modelo en ghostTyper.${provider.modelSetting}.`);
    return;
  }
  const apiKey = (await context.secrets.get(provider.secret)) || (await askApiKey(context, provider));
  if (!apiKey) return;

  const block = readCommentBlock(editor.document, editor.selection.active.line);
  if (!block.problem) {
    vscode.window.showWarningMessage('Ghost Typer: no encontré un comentario sobre el cursor.');
    return;
  }

  let typeOverride;
  try {
    typeOverride = vscode.commands.registerCommand('type', onKey);
  } catch {
    vscode.window.showErrorMessage('Ghost Typer: otra extensión (p. ej. Vim) ya controla el teclado.');
    return;
  }

  if (block.cursorOnComment) {
    const end = editor.document.lineAt(block.endLine).range.end;
    editor.selection = new vscode.Selection(end, end);
  }

  const current = {
    editor,
    typeOverride,
    abort: new AbortController(),
    raw: '',
    lead: null,
    indentation: block.indentation,
    buffer: '',
    offset: 0,
    writeOffset: null,
    expected: null,
    owed: 0,
    done: false,
    finished: false,
    releaseTimer: null,
    pending: Promise.resolve(),
  };
  current.changeListener = vscode.workspace.onDidChangeTextDocument((event) => onDocumentChange(current, event));
  session = current;
  vscode.commands.executeCommand('setContext', 'ghostTyper.active', true);
  showStatus('loading~spin', 'pensando…');

  const onText = (text) => {
    if (current.lead === null) {
      const atLineStart = block.cursorOnComment || editor.selection.active.character === 0;
      current.lead = (block.cursorOnComment ? '\n' : '') + (atLineStart ? block.indentation : '');
      showStatus('keyboard', 'listo, escribe');
    }
    current.raw += text.replace(/\r/g, '');
    refreshBuffer(current);
  };

  try {
    const stopReason = await streamSolution(
      provider,
      apiKey,
      block.problem,
      editor.document.languageId,
      onText,
      current.abort.signal
    );
    if (session !== current) return;
    current.done = true;
    refreshBuffer(current);
    if (stopReason === 'refusal') vscode.window.showWarningMessage('Ghost Typer: el modelo no quiso resolver este problema.');
    if (stopReason === 'max_tokens') vscode.window.showWarningMessage('Ghost Typer: la solución se cortó por max_tokens.');
    if (!current.buffer.trim()) {
      stop();
      vscode.window.showWarningMessage('Ghost Typer: el modelo no devolvió código.');
    }
  } catch (error) {
    if (session !== current) return;
    stop();
    vscode.window.showErrorMessage(`Ghost Typer: ${error.message}`);
  }
}

function readCommentBlock(document, cursorLine) {
  const isComment = (line) =>
    line >= 0 && line < document.lineCount && COMMENT_PREFIX.test(document.lineAt(line).text);
  const cursorOnComment = isComment(cursorLine);

  let last = cursorOnComment ? cursorLine : cursorLine - 1;
  if (!isComment(last)) return { problem: '' };
  if (cursorOnComment) while (isComment(last + 1)) last++;
  let first = last;
  while (isComment(first - 1)) first--;

  const lines = [];
  for (let line = first; line <= last; line++) lines.push(document.lineAt(line).text);
  return {
    problem: lines
      .map((text) => text.replace(COMMENT_PREFIX, '').replace(/\s*\*\/\s*$/, ''))
      .join('\n')
      .trim(),
    indentation: lines[0].match(/^\s*/)[0],
    cursorOnComment,
    endLine: last,
  };
}

async function streamSolution(provider, apiKey, problem, languageId, onText, signal) {
  const system =
    `Eres un programador experto. Responde SOLO con código ${languageId} listo para pegar, ` +
    'sin bloques markdown ni explicaciones fuera del código. Comentarios breves dentro del código están bien.';
  const response = await fetch(provider.url, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', ...provider.headers(apiKey) },
    body: JSON.stringify(provider.body(vscode.workspace.getConfiguration('ghostTyper'), system, problem)),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error?.message || `HTTP ${response.status}`);
  }

  // Server-sent events: bloques "event: …\ndata: {json}" separados por una línea en blanco.
  const decoder = new TextDecoder();
  let unread = '';
  let stopReason = null;
  for await (const bytes of response.body) {
    unread += decoder.decode(bytes, { stream: true }).replace(/\r\n/g, '\n');
    const events = unread.split('\n\n');
    unread = events.pop();
    for (const event of events) {
      const data = event.split('\n').find((line) => line.startsWith('data:'))?.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      const parsed = provider.parse(JSON.parse(data));
      if (parsed.text) onText(parsed.text);
      if (parsed.stopReason) stopReason = parsed.stopReason;
    }
  }
  return stopReason;
}

function refreshBuffer(current) {
  current.buffer = current.lead + indent(cleanCode(current.raw, current.done), current.indentation);
  current.pending = current.pending.then(() => typeOwedChunks(current));
}

// Mientras llega la respuesta se retiene lo que todavía podría ser un bloque ```,
// para no escribir nada que después haya que quitar.
function cleanCode(raw, finished) {
  if (!finished && raw.startsWith('`') && !raw.includes('\n')) return '';
  const code = raw.replace(/^```[\w-]*\n/, '');
  return finished ? code.replace(/\n?```\s*$/, '') : code.replace(/\n?`*\s*$/, '');
}

function indent(code, indentation) {
  return code.replace(/\n/g, `\n${indentation}`);
}

// Cada tecla imprimible llega aquí en lugar de escribirse; Enter también pasa por 'type'.
function onKey(args) {
  const current = session;
  if (vscode.window.activeTextEditor !== current.editor) {
    return vscode.commands.executeCommand('default:type', args);
  }
  if (current.finished) return holdUntilQuiet(current);
  if (current.lead === null) return;
  current.owed++;
  current.pending = current.pending.then(() => typeOwedChunks(current));
}

// Escribe un fragmento por cada tecla pendiente. Si las teclas van más rápido que Claude,
// quedan pendientes y se escriben en cuanto llega más texto.
async function typeOwedChunks(current) {
  const average = vscode.workspace.getConfiguration('ghostTyper').get('charsPerKey');
  while (session === current && current.owed > 0 && current.offset < current.buffer.length) {
    const end = chunkEnd(current.buffer, current.offset, chunkSize(average));
    const chunk = current.buffer.slice(current.offset, end);
    const isFirstChunk = current.offset === 0;
    current.offset += chunk.length;
    current.owed--;
    if (!(await insertChunk(current, chunk, isFirstChunk))) {
      if (session !== current) return;
      stop();
      vscode.window.showErrorMessage('Ghost Typer: VS Code no aceptó la edición (¿equipo muy cargado?). Se detuvo para no desordenar el código.');
      return;
    }
  }
  if (session !== current || current.offset === 0) return;

  if (!current.done) {
    showStatus('sync~spin', 'el modelo sigue escribiendo…');
  } else if (current.offset >= current.buffer.length) {
    if (!current.finished) finish(current);
  } else {
    const percent = Math.round((current.offset / current.buffer.length) * 100);
    showStatus('keyboard', `${percent}%`);
  }
}

// La posición de escritura la lleva la extensión: si otra extensión mueve el cursor
// (p. ej. al abrir un docstring con """), el texto sigue saliendo en orden.
// En archivos CRLF VS Code convierte cada \n en \r\n, así que se inserta ya convertido
// para que la longitud insertada coincida con lo que queda en el documento.
async function insertChunk(current, chunk, isFirstChunk) {
  const { editor } = current;
  const document = editor.document;
  const text = document.eol === vscode.EndOfLine.CRLF ? chunk.replace(/\n/g, '\r\n') : chunk;
  current.writeOffset ??= document.offsetAt(editor.selection.active);
  const applied = await editWithRetry(
    current,
    () => {
      const offset = current.writeOffset;
      current.expected = { offset, text };
      return (edit) => edit.insert(document.positionAt(offset), text);
    },
    { undoStopBefore: isFirstChunk, undoStopAfter: false }
  );
  if (!applied) return false;
  // Normalmente onDocumentChange ya movió writeOffset; esto cubre el caso en que no reconoció el cambio.
  if (current.expected) {
    current.writeOffset = current.expected.offset + text.length;
    current.expected = null;
  }
  moveCursorToWriteOffset(current);
  editor.revealRange(editor.selection);
  return true;
}

// Con el equipo cargado, otra edición (Pylance, un formateador, una tecla) puede aplicarse entre
// que se pide la edición y VS Code la procesa. Entonces editor.edit devuelve false sin escribir nada,
// así que se vuelve a intentar desde la posición ya actualizada en lugar de dar el texto por escrito.
// build devuelve la edición a aplicar, o null si ya no hay nada que hacer.
async function editWithRetry(current, build, options) {
  for (let attempt = 1; attempt <= EDIT_ATTEMPTS; attempt++) {
    if (session !== current) return false;
    const callback = build();
    if (!callback) return true;
    try {
      if (await current.editor.edit(callback, options)) return true;
    } catch {
      return false;
    }
    current.expected = null;
    await new Promise((resolve) => setTimeout(resolve, attempt * 20));
  }
  return false;
}

function moveCursorToWriteOffset(current) {
  const position = current.editor.document.positionAt(current.writeOffset);
  current.editor.selection = new vscode.Selection(position, position);
}

// Los cambios ajenos que caen antes de la posición de escritura la desplazan.
// Otras extensiones reaccionan a lo que se escribe: Pylance, por ejemplo, cierra el docstring
// apenas aparece un """. Ese texto queda justo detrás de la posición de escritura y acabaría
// al final del código, así que se quita.
function onDocumentChange(current, event) {
  if (session !== current || event.document !== current.editor.document) return;
  for (const change of event.contentChanges) {
    const { expected } = current;
    if (expected && change.rangeLength === 0 && change.rangeOffset === expected.offset && change.text === expected.text) {
      current.writeOffset = expected.offset + expected.text.length;
      current.expected = null;
    } else if (current.writeOffset === null) {
      continue;
    } else if (change.rangeLength === 0 && change.text && change.rangeOffset === current.writeOffset) {
      current.pending = current.pending.then(() => removeForeignText(current, change.text));
    } else if (change.rangeOffset + change.rangeLength <= current.writeOffset) {
      current.writeOffset += change.text.length - change.rangeLength;
    }
  }
}

async function removeForeignText(current, text) {
  const document = current.editor.document;
  await editWithRetry(
    current,
    () => {
      const range = new vscode.Range(
        document.positionAt(current.writeOffset),
        document.positionAt(current.writeOffset + text.length)
      );
      if (document.getText(range) !== text) return null;
      return (edit) => edit.delete(range);
    },
    { undoStopBefore: false, undoStopAfter: false }
  );
  if (session === current) moveCursorToWriteOffset(current);
}

// Solo los caracteres visibles cuentan para el tamaño del fragmento. Los espacios, tabs y
// saltos de línea que siguen se escriben con la misma tecla, como la sangría automática.
function chunkEnd(buffer, offset, visibleChars) {
  let end = offset;
  let visible = 0;
  while (end < buffer.length && visible < visibleChars) {
    if (!/\s/.test(buffer[end])) visible++;
    end++;
  }
  while (end < buffer.length && /\s/.test(buffer[end])) end++;
  return end;
}

// Un tamaño al azar alrededor del promedio (3 → entre 2 y 4) para que no se vea mecánico.
function chunkSize(average) {
  const min = Math.ceil(average / 2);
  const max = average + Math.floor(average / 2);
  return min + Math.floor(Math.random() * (max - min + 1));
}

// Al terminar se siguen tragando las teclas hasta que dejas de teclear un momento,
// para que las teclas de más no acaben escritas después del código.
function finish(current) {
  current.finished = true;
  showStatus('check', 'terminado');
  holdUntilQuiet(current);
}

function holdUntilQuiet(current) {
  clearTimeout(current.releaseTimer);
  current.releaseTimer = setTimeout(() => {
    if (session !== current) return;
    stop();
    const label = statusLabel('check', 'terminado');
    if (label) vscode.window.setStatusBarMessage(label, 4000);
  }, RELEASE_AFTER_QUIET_MS);
}

function stop() {
  if (!session) return;
  clearTimeout(session.releaseTimer);
  session.abort.abort();
  session.typeOverride.dispose();
  session.changeListener.dispose();
  session = null;
  vscode.commands.executeCommand('setContext', 'ghostTyper.active', false);
  statusBar.hide();
}

function showStatus(icon, text) {
  const label = statusLabel(icon, text);
  if (!label) return statusBar.hide();
  statusBar.text = label;
  statusBar.tooltip = `Ghost Typer: ${text}`;
  statusBar.show();
}

// El ajuste statusBar decide cuánto se ve: solo el ícono, ícono y texto, o nada.
function statusLabel(icon, text) {
  const style = vscode.workspace.getConfiguration('ghostTyper').get('statusBar');
  if (style === 'hidden') return null;
  return style === 'full' ? `$(${icon}) Ghost: ${text}` : `$(${icon})`;
}

module.exports = { activate, deactivate: stop };
