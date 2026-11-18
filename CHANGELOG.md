# Cambios

## 0.4.7

- Ya no queda un `"""` suelto al final del código en Python. Lo insertaba Pylance al cerrar solo cada docstring, y ahora se quita.

## 0.4.6

- En archivos con saltos de línea CRLF (lo normal en Windows) el texto ya no se descuadra después de cada salto de línea: salía con la sangría corrida, letras perdidas y comillas de más.

## 0.4.5

- El texto ya no se desordena si otra extensión mueve el cursor mientras se escribe (pasaba al abrir un docstring con `"""` en Python).

## 0.4.4

- La barra de estado es minimalista por defecto: solo un ícono (pensando, listo, terminado). Al pasar el mouse se ve el texto.
- Nuevo ajuste `ghostTyper.statusBar`: `minimal`, `full` (ícono y texto, como antes) o `hidden` (no muestra nada).

## 0.4.3

- La sangría y los saltos de línea ya no gastan teclas: salen junto con los caracteres anteriores.

## 0.4.2

- Al terminar, las teclas de más se ignoran hasta que dejas de teclear 1.5 segundos, y la barra de estado marca que terminó.

## 0.4.1

- `openai/gpt-oss-120b` es el modelo por defecto de Groq.

## 0.4.0

- Nuevo proveedor gratuito: Groq.

## 0.3.0

- Nuevo proveedor: OpenRouter (tiene modelos gratuitos).
- Ajuste `ghostTyper.provider` para elegir proveedor; cada uno guarda su propia API key.

## 0.2.0

- La solución llega en streaming: puedes teclear mientras la IA todavía la genera.
- Si tecleas más rápido de lo que la IA genera, las teclas se guardan.
- Nuevo ajuste `ghostTyper.effort` para que Claude empiece antes.
- Los caracteres por tecla varían un poco para que se vea natural.
- Correcciones: la solución ya no parte el comentario, se lee el comentario completo, se puede teclear en otros archivos mientras está activo y `Ctrl+Z` no borra el comentario.

## 0.1.0

- Primera versión.
