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
    owed: 0,
    done: false,
    finished: false,
    releaseTimer: null,
    pending: Promise.resolve(),
  };
  session = current;
  vscode.commands.executeCommand('setContext', 'ghostTyper.active', true);
  showStatus('$(loading~spin) Ghost: pensando…');

  const onText = (text) => {
    if (current.lead === null) {
      const atLineStart = block.cursorOnComment || editor.selection.active.character === 0;
      current.lead = (block.cursorOnComment ? '\n' : '') + (atLineStart ? block.indentation : '');
      showStatus('$(keyboard) Ghost: listo, escribe');
    }
    current.raw += text;
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
    await current.editor.edit(
      (edit) => edit.insert(current.editor.selection.active, chunk),
      { undoStopBefore: isFirstChunk, undoStopAfter: false }
    );
    current.editor.revealRange(current.editor.selection);
  }
  if (session !== current || current.offset === 0) return;

  if (!current.done) {
    showStatus('$(sync~spin) Ghost: el modelo sigue escribiendo…');
  } else if (current.offset >= current.buffer.length) {
    if (!current.finished) finish(current);
  } else {
    const percent = Math.round((current.offset / current.buffer.length) * 100);
    showStatus(`$(keyboard) Ghost: ${percent}%`);
  }
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
  showStatus('$(check) Ghost: terminado');
  holdUntilQuiet(current);
}

function holdUntilQuiet(current) {
  clearTimeout(current.releaseTimer);
  current.releaseTimer = setTimeout(() => {
    if (session !== current) return;
    stop();
    vscode.window.setStatusBarMessage('$(check) Ghost: terminado', 4000);
  }, RELEASE_AFTER_QUIET_MS);
}

function stop() {
  if (!session) return;
  clearTimeout(session.releaseTimer);
  session.abort.abort();
  session.typeOverride.dispose();
  session = null;
  vscode.commands.executeCommand('setContext', 'ghostTyper.active', false);
  statusBar.hide();
}

function showStatus(text) {
  statusBar.text = text;
  statusBar.show();
}

module.exports = { activate, deactivate: stop };
