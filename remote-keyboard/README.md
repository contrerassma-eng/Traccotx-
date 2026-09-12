# Teclado Remoto por WiFi para proyector Android

Control de teclado (y de todos los botones de un control remoto) para un proyector
Android **sin teclado ni control remoto**, desde el navegador del teléfono. No hay que
instalar nada en el teléfono ni en el proyector.

**Vía recomendada (Opción B):** un ESP32-S3 enchufado al USB del proyector. Para el
proyector es solo un teclado USB; el ESP32 crea su propia red WiFi con portal cautivo:
al conectar el teléfono a esa red, la página de control se abre sola y desde ahí
pulsas botones (flechas, OK, Volver, Inicio, volumen…) y escribes texto. Los comandos
van por WebSocket local.

Hay **dos formas** de usarlo; la página web de control es la misma en ambas:

| | Opción A · App Android | Opción B · Adaptador USB (ESP32) |
|---|---|---|
| Qué se instala | Un APK en el proyector | Nada en el proyector; un ESP32-S2/S3 en el puerto USB |
| Escribir texto | ✅ Cualquier carácter (tildes, ñ, emojis) | ⚠️ Solo ASCII (sin tildes ni ñ) |
| Flechas / OK / Enter | ✅ Dentro de la app con el campo de texto activo (y en todo el sistema con accesibilidad) | ✅ En todo el sistema, siempre |
| Volver / Inicio / Recientes | ✅ Activando el servicio de accesibilidad | ✅ Siempre |
| Volumen, play/pausa | ✅ | ✅ |
| Encender / apagar | ❌ | ✅ (tecla Power por USB, si el proyector la respeta) |
| Requisitos | Poder instalar APKs (pendrive o descarga) | Un **ESP32-S2 o ESP32-S3** (USB nativo). El ESP32 clásico y el C3 **no** sirven |

> Sin control remoto no hay forma de navegar el proyector para instalar un APK, así que
> empieza por la opción B. Una vez que el ESP32 funcione como teclado ya puedes moverte
> por todo el sistema y, si quieres tildes y ñ, instalar después la app (opción A) con
> el propio ESP32 como teclado. Las dos pueden convivir.

---

## Opción A · App Android (`app/`)

### 1. Obtener el APK

- **Desde GitHub Actions**: pestaña *Actions* → workflow *Teclado Remoto* → *Run workflow*.
  Al terminar, descarga el artefacto `TecladoRemoto-apk` (o el release
  `teclado-remoto-latest`, que tiene el `TecladoRemoto.apk` directo).
- **Compilar localmente** (JDK 17+ y Android SDK con `platforms;android-34`):

  ```bash
  cd remote-keyboard
  ANDROID_HOME=/ruta/al/sdk ./gradlew assembleDebug
  # → app/build/outputs/apk/debug/app-debug.apk
  ```

### 2. Instalar en el proyector

1. Copia el APK a un pendrive y ábrelo con el explorador de archivos del proyector
   (o descárgalo desde el navegador del proyector). Acepta «instalar apps de origen
   desconocido» si lo pide.
2. Abre **Teclado Remoto** y sigue los pasos en pantalla:
   - **Paso 1** · *Abrir ajustes de teclado* → activa «Teclado Remoto (WiFi)».
   - **Paso 2** · *Elegir teclado* → selecciona «Teclado Remoto (WiFi)».
   - **Paso 3 (opcional)** · *Ajustes de accesibilidad* → activa «Teclado Remoto – Botones
     del sistema». Habilita Volver / Inicio / Recientes y las flechas fuera de los campos de texto.
3. La pantalla muestra la dirección (por ejemplo `http://192.168.1.50:8765`) y un **código QR**.

### 3. Usar

1. En el teléfono (misma WiFi) abre esa dirección o escanea el QR.
2. En el proyector, con el control remoto, entra en el campo donde quieras escribir
   (buscador de YouTube, contraseña WiFi, etc.). Aparece una franja azul oscura en lugar del
   teclado: significa que el Teclado Remoto está activo.
3. En el teléfono escribe en «Escritura en vivo» (cada letra se envía al instante) o pega
   un texto largo en «Enviar un texto completo».

Para volver al teclado normal del proyector: Ajustes → Teclados → elegir el teclado original
(o mantener pulsado en un campo de texto si el sistema ofrece el selector).

### Cómo funciona

- `RemoteInputMethodService` es un teclado (IME) sin teclas: inyecta en el campo con foco el
  texto que llega por la red (`commitText`) y envía teclas especiales (`sendDownUpKeyEvents`).
  Enter ejecuta la acción del campo (Buscar / Ir / Enviar) igual que un teclado normal.
- `RemoteAccessibilityService` (opcional) ejecuta Volver / Inicio / Recientes y mueve el foco
  con las flechas cuando no hay campo de texto.
- `RemoteServer` es un servidor HTTP (NanoHTTPD) en el puerto **8765** (o el siguiente libre)
  que sirve `assets/index.html` y la API. Volumen y reproducción se manejan con `AudioManager`,
  por lo que funcionan siempre.
- `MainActivity` guía la configuración y muestra la dirección y el QR.

---

## Opción B · Adaptador USB con ESP32 (`esp32-usb/`)

El ESP32 se enchufa al puerto USB del proyector y se presenta **únicamente** como teclado
USB + control multimedia (HID): sin puerto serie ni otras interfaces, igual que un teclado
normal. Recibe las órdenes por WiFi desde la misma página web, por **WebSocket** (puerto 81,
baja latencia) con HTTP como respaldo.

### Hardware

- **ESP32-S3** (DevKitC, S3 mini, etc.) o **ESP32-S2** (S2 mini, Saola…). Necesitan USB nativo;
  el ESP32 «clásico» (WROOM/WROVER) y el ESP32-C3 no pueden actuar como teclado USB.
- Conecta al proyector el puerto marcado **USB / OTG** de la placa (en las placas con dos
  conectores, el que va directo al chip, no el del puente UART). El proyector alimenta la placa.

### Grabar el firmware

**Sin instalar nada (recomendado):**

1. Descarga `TecladoRemotoUSB-esp32s3.bin` (o `-esp32s2.bin`) del artefacto
   `TecladoRemotoUSB-firmware` en GitHub Actions o del release `teclado-remoto-latest`.
2. Con Chrome/Edge en un PC abre <https://espressif.github.io/esptool-js/>, conecta la placa
   por USB (manteniendo pulsado **BOOT** al conectarla si no la detecta), *Connect*,
   dirección `0x0`, elige el `.bin` y *Program*.

**Con Arduino IDE 2.x:**

1. Instala el core «esp32» de Espressif (Gestor de placas, versión ≥ 2.0.5) y la librería
   **WebSockets** de Markus Sattler (Gestor de librerías).
2. Abre `esp32-usb/TecladoRemotoUSB/TecladoRemotoUSB.ino`.
3. Placa: *ESP32S3 Dev Module* (o *ESP32S2 Dev Module*). En **Herramientas**:
   *USB Mode → USB-OTG (TinyUSB)* (solo S3) y *USB CDC On Boot → Disabled* (así el proyector
   ve solo un teclado; los mensajes de depuración salen por el puerto UART de la placa).
4. Opcional: copia `config.h.example` como `config.h` con tu red WiFi.
5. Sube (con *USB CDC On Boot* apagado, para subir de nuevo mantén **BOOT** y pulsa **RESET**).

### Usar (sin control remoto, sin tocar el proyector)

1. Enchufa el ESP32 al USB del proyector. Se enciende y crea la red WiFi
   **`TecladoRemoto`** (clave `teclado123`).
2. En el teléfono, conéctate a esa red. Por el **portal cautivo** aparece sola la página de
   control («Iniciar sesión en la red» / «Sign in»). Si se cierra, abre **http://192.168.4.1**
   en el navegador. El teléfono no tiene Internet mientras está en esa red (usará datos
   móviles si los tiene).
3. Pulsa botones: flechas y OK para navegar, Volver, Inicio, Recientes, volumen, play/pausa,
   encender/apagar. Escribe en «Escritura en vivo» cuando el cursor esté en un campo de texto
   del proyector. Funciona en cualquier pantalla (menús, ajustes, apps).

**Opcional: usar tu WiFi de casa** (para no cambiar de red en el teléfono). En la tarjeta
«WiFi del adaptador USB» escribe el nombre y la clave de tu red y pulsa *Guardar y
reiniciar*. El adaptador se une a tu red y **sigue ofreciendo** la red propia como respaldo;
al volver a entrar por `TecladoRemoto` verás la dirección que le tocó en tu red (por
ejemplo `http://192.168.1.77`). Desde un PC también sirve `http://teclado.local`.

Limitación: por USB solo se pueden escribir caracteres ASCII (el proyector usa distribución de
teclado US). La página avisa si descartó tildes o ñ; para esos casos usa la app Android.

---

## API HTTP (igual en ambas opciones)

| Método | Ruta | Parámetros (formulario) | Efecto |
|---|---|---|---|
| GET | `/` | — | Página de control |
| GET | `/api/status` | — | Estado en JSON |
| POST | `/api/text` | `text` | Escribe el texto en el campo con foco |
| POST | `/api/key` | `key`, `count` (opcional) | Tecla especial: `ENTER BACKSPACE DELETE SPACE TAB ESC UP DOWN LEFT RIGHT CENTER BACK HOME RECENTS MENU SEARCH MOVE_HOME MOVE_END PAGE_UP PAGE_DOWN VOL_UP VOL_DOWN MUTE PLAY_PAUSE STOP NEXT PREVIOUS REWIND FAST_FORWARD` (+ `POWER`, `SLEEP` solo por USB) |
| POST | `/api/clear` | — | Borra todo el campo con foco |
| POST | `/api/wifi` | `ssid`, `pass` | Solo ESP32: guarda la red y reinicia (`ssid` vacío = olvidar) |

Ejemplo: `curl -d "key=ENTER" http://192.168.4.1/api/key`

**WebSocket (solo ESP32)**: `ws://<ip>:81/`, mensajes de texto separados por tabulador,
respuesta con el mismo `id` seguido del JSON:

```
1<TAB>text<TAB>hola mundo      →  1<TAB>{"ok":true,...}
2<TAB>key<TAB>DOWN<TAB>3       →  2<TAB>{"ok":true,...}
3<TAB>clear                    →  3<TAB>{"ok":true,...}
4<TAB>status                   →  4<TAB>{estado JSON}
```

La página usa WebSocket cuando `/api/status` devuelve `ws` y cae a HTTP si se corta.

## Estructura

```
remote-keyboard/
├── app/                      App Android (Kotlin, minSdk 21)
│   └── src/main/assets/index.html   Página de control (compartida con el ESP32)
├── esp32-usb/TecladoRemotoUSB/      Firmware Arduino para ESP32-S2/S3
│   ├── TecladoRemotoUSB.ino
│   ├── web_page.h            Generado desde index.html (tools/gen_web_page.py)
│   └── config.h.example      Plantilla de red WiFi (config.h no se versiona)
└── tools/                    gen_icons.py (íconos PNG), gen_web_page.py
```

Si modificas `index.html`, ejecuta `python3 tools/gen_web_page.py` para actualizar el firmware.

## Seguridad

El servidor no pide contraseña: cualquiera en la misma red que conozca la dirección puede
escribir en el proyector. La red propia del ESP32 está protegida por la clave `AP_PASS`
(cámbiala en `config.h`). Está pensado para uso doméstico; no abras el puerto a Internet.
