# Ghost Typer

Extensión de VS Code para demos. Escribes un problema como comentario, activas Ghost Typer y cada tecla que oprimas, la que sea, va escribiendo la solución que generó una IA, como si la estuvieras tecleando tú.

```python
# función que recibe una lista de números y devuelve
# solo los primos, ordenados de mayor a menor
█  ← Ctrl+Alt+G y teclea cualquier cosa
```

Funciona con **Claude** (Anthropic), **Groq** (gratis) y **OpenRouter** (tiene modelos gratuitos).

## Instalación

Descarga el `.vsix` de la sección [Releases](https://github.com/Ang3lRamos/ghost-typer/releases) o genéralo tú mismo (ver [Desarrollo](#desarrollo)), y luego:

```bash
code --install-extension ghost-typer-0.4.3.vsix
```

O en VS Code: **Extensiones** → `...` → **Install from VSIX...**

## Configuración inicial

1. Consigue una API key de alguno de estos proveedores:

   | Proveedor | Dónde sacar la key | Costo |
   |---|---|---|
   | Groq | console.groq.com → API Keys | Gratis, con límites por minuto y por día |
   | OpenRouter | openrouter.ai → Keys | Gratis con modelos que terminan en `:free` |
   | Anthropic | console.anthropic.com | De pago |

2. Abre los ajustes (`Ctrl` + `,`), busca `ghostTyper` y elige el proveedor en **Provider**.
3. `Ctrl+Shift+P` → **Ghost Typer: Configurar API key** → pega tu key.
   La cajita dice de qué proveedor es la key; revisa que coincida con el que elegiste.

## Uso

1. Escribe el problema como comentario (`#`, `//`, `--` o `/* */`), en una o varias líneas.
2. Deja el cursor en la línea de abajo, o sobre el comentario, y oprime `Ctrl+Alt+G` (`Cmd+Alt+G` en Mac).
3. Espera a que la barra de estado, abajo a la izquierda, cambie de **Ghost: pensando…** a **Ghost: listo, escribe**.
4. Teclea lo que sea. Cada tecla escribe unos cuantos caracteres de la solución.
5. Al terminar, la barra dice **✓ Ghost: terminado**.

| Situación | Qué pasa |
|---|---|
| Tecleas mientras la IA piensa | Las teclas se ignoran |
| Tecleas más rápido de lo que la IA genera | Las teclas se guardan y se escriben en cuanto llega más texto |
| Sigues tecleando después de terminar | Las teclas se ignoran hasta que dejas de teclear 1.5 segundos |
| Llegas a una sangría o a un salto de línea | Sale con la misma tecla; no gasta teclas |
| Oprimes `Esc` | Se detiene y el teclado vuelve a la normalidad |
| Oprimes `Ctrl+Z` al final | Se borra toda la solución de una vez |

## Ajustes

| Ajuste | Por defecto | Para qué |
|---|---|---|
| `ghostTyper.provider` | `anthropic` | `anthropic`, `groq` u `openrouter` |
| `ghostTyper.groqModel` | `openai/gpt-oss-120b` | Modelo de Groq ([lista](https://console.groq.com/docs/models)) |
| `ghostTyper.openrouterModel` | vacío | Modelo de OpenRouter ([lista](https://openrouter.ai/models)); los gratuitos terminan en `:free` |
| `ghostTyper.model` | `claude-sonnet-5-5` | Modelo de Claude |
| `ghostTyper.effort` | `low` | Cuánto piensa Claude antes de escribir; más bajo empieza antes. Solo Anthropic |
| `ghostTyper.charsPerKey` | `3` | Caracteres visibles por tecla, en promedio (con 3, entre 2 y 4). Con `1` escribes exactamente lo que ves |

## Tus API keys

- **Se guardan en el almacén seguro de VS Code** (el administrador de credenciales del sistema), no en los ajustes ni en archivos del proyecto. No se suben a ningún repositorio.
- **Cada proveedor tiene su propia key.** Puedes tener varias y cambiar de proveedor con un solo ajuste.
- **Para cambiarla**, elige el proveedor y vuelve a correr **Ghost Typer: Configurar API key**.

El comentario que escribes se envía al proveedor que elegiste. Algunos proveedores gratuitos usan las peticiones para entrenar sus modelos, así que no les mandes código privado.

## Problemas comunes

| Mensaje | Causa y solución |
|---|---|
| `invalid x-api-key` | Es un error de Anthropic: el proveedor sigue en `anthropic`. Cámbialo y vuelve a poner la key |
| `falta elegir el modelo en ghostTyper.…` | Escribe un modelo en ese ajuste |
| Error de límite (rate limit) | Pasaste el límite gratuito por minuto; espera un minuto. Si pasa seguido, usa un modelo más ligero |
| `otra extensión (p. ej. Vim) ya controla el teclado` | Desactiva esa extensión mientras usas Ghost Typer |
| No pasa nada con `Ctrl+Alt+G` | Haz clic dentro del editor y revisa que haya un comentario sobre el cursor |

## Cómo funciona

VS Code envía cada tecla imprimible (y Enter) al comando `type`. Mientras Ghost Typer está activo, registra su propio `type`, descarta la tecla real e inserta el siguiente fragmento de la solución. Al terminar o al oprimir `Esc` libera el comando y el teclado vuelve a la normalidad.

La solución llega en streaming, así que puedes empezar a teclear antes de que la IA termine de generarla.

## Desarrollo

Es JavaScript plano, sin dependencias ni paso de compilación. Todo el código está en `extension.js`.

- **Probar cambios:** abre la carpeta en VS Code y oprime `F5` para abrir una ventana con la extensión cargada.
- **Empaquetar:**
  ```bash
  npx @vscode/vsce package
  ```

## Licencia

[MIT](LICENSE)
