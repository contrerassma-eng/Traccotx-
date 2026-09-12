/*
 * Teclado Remoto USB — firmware para ESP32-S2 / ESP32-S3
 * ------------------------------------------------------
 * El ESP32 se conecta al puerto USB del proyector y se presenta como un teclado
 * USB + control multimedia (HID). Un teléfono en la misma red WiFi abre la página
 * web que sirve el ESP32 y desde ahí escribe texto y pulsa todas las teclas de un
 * control remoto: flechas, OK, Volver, Inicio, Recientes, volumen, play/pausa…
 *
 * No hay que instalar nada en el proyector: para Android es un teclado más.
 *
 * Placa:  ESP32-S2 o ESP32-S3 (USB nativo). El ESP32 clásico y el C3 NO sirven.
 * IDE:    Arduino IDE 2.x con el core "esp32" de Espressif (>= 2.0.5).
 *         Herramientas → USB Mode → "USB-OTG (TinyUSB)"   (solo S3)
 *         Herramientas → USB CDC On Boot → "Enabled" (opcional, para ver el monitor serie)
 *
 * API (misma que la app Android):
 *   GET  /              página web
 *   GET  /api/status    estado (JSON)
 *   POST /api/text      text=…            escribe texto (solo ASCII)
 *   POST /api/key       key=ENTER&count=1 tecla especial
 *   POST /api/clear     Ctrl+A + Retroceso
 *   POST /api/wifi      ssid=…&pass=…     guarda la red WiFi y reinicia
 */

#if !defined(CONFIG_IDF_TARGET_ESP32S2) && !defined(CONFIG_IDF_TARGET_ESP32S3)
#error "Este firmware necesita un ESP32-S2 o ESP32-S3 (USB nativo). El ESP32 clasico y el C3 no pueden actuar como teclado USB."
#endif
#if defined(ARDUINO_USB_MODE) && ARDUINO_USB_MODE == 1
#error "En Herramientas -> USB Mode elige 'USB-OTG (TinyUSB)'."
#endif

#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include "USB.h"
#include "USBHIDKeyboard.h"
#include "USBHIDConsumerControl.h"
#include "web_page.h"

#if __has_include("config.h")
#include "config.h"
#endif
#ifndef WIFI_SSID
#define WIFI_SSID ""
#endif
#ifndef WIFI_PASS
#define WIFI_PASS ""
#endif
#ifndef AP_SSID
#define AP_SSID "TecladoRemoto"
#endif
#ifndef AP_PASS
#define AP_PASS "teclado123"
#endif
#ifndef AP_ALWAYS
#define AP_ALWAYS 1
#endif
#ifndef HOSTNAME
#define HOSTNAME "teclado"
#endif

#define VERSION "1.0-usb"
#define HTTP_PORT 80
#define STA_TIMEOUT_MS 20000
#define KEY_DELAY_MS 6

USBHIDKeyboard Keyboard;
USBHIDConsumerControl Consumer;
WebServer server(HTTP_PORT);
Preferences prefs;

volatile bool usbMounted = false;
bool apActive = false;
String staSsid;
unsigned long lastReconnect = 0;

// ---------------------------------------------------------------- teclas
// usage HID "Consumer Control" (página 0x0C). Android los traduce a sus KEYCODE_*.
#define CC_POWER        0x0030
#define CC_SLEEP        0x0032
#define CC_MENU         0x0040
#define CC_PLAY_PAUSE   0x00CD
#define CC_STOP         0x00B7
#define CC_NEXT         0x00B5
#define CC_PREVIOUS     0x00B6
#define CC_REWIND       0x00B4
#define CC_FAST_FORWARD 0x00B3
#define CC_MUTE         0x00E2
#define CC_VOL_UP       0x00E9
#define CC_VOL_DOWN     0x00EA
#define CC_AL_TASK      0x01A2  // "AL Select Task/Application" → Recientes
#define CC_AC_SEARCH    0x0221
#define CC_AC_HOME      0x0223
#define CC_AC_BACK      0x0224

struct KeyDef {
  const char* name;
  uint8_t key;        // código de teclado (0 = no aplica)
  uint16_t consumer;  // usage consumer (0 = no aplica)
};

const KeyDef KEYS[] = {
  {"ENTER", KEY_RETURN, 0},
  {"CENTER", KEY_RETURN, 0},
  {"BACKSPACE", KEY_BACKSPACE, 0},
  {"DELETE", KEY_DELETE, 0},
  {"SPACE", ' ', 0},
  {"TAB", KEY_TAB, 0},
  {"ESC", KEY_ESC, 0},
  {"UP", KEY_UP_ARROW, 0},
  {"DOWN", KEY_DOWN_ARROW, 0},
  {"LEFT", KEY_LEFT_ARROW, 0},
  {"RIGHT", KEY_RIGHT_ARROW, 0},
  {"MOVE_HOME", KEY_HOME, 0},
  {"MOVE_END", KEY_END, 0},
  {"PAGE_UP", KEY_PAGE_UP, 0},
  {"PAGE_DOWN", KEY_PAGE_DOWN, 0},
  {"BACK", 0, CC_AC_BACK},
  {"HOME", 0, CC_AC_HOME},
  {"RECENTS", 0, CC_AL_TASK},
  {"MENU", 0, CC_MENU},
  {"SEARCH", 0, CC_AC_SEARCH},
  {"VOL_UP", 0, CC_VOL_UP},
  {"VOL_DOWN", 0, CC_VOL_DOWN},
  {"MUTE", 0, CC_MUTE},
  {"PLAY_PAUSE", 0, CC_PLAY_PAUSE},
  {"STOP", 0, CC_STOP},
  {"NEXT", 0, CC_NEXT},
  {"PREVIOUS", 0, CC_PREVIOUS},
  {"REWIND", 0, CC_REWIND},
  {"FAST_FORWARD", 0, CC_FAST_FORWARD},
  {"POWER", 0, CC_POWER},
  {"SLEEP", 0, CC_SLEEP},
};

const KeyDef* findKey(const String& name) {
  for (const KeyDef& k : KEYS) {
    if (name.equalsIgnoreCase(k.name)) return &k;
  }
  return nullptr;
}

void pressKey(const KeyDef& k) {
  if (k.consumer) {
    Consumer.press(k.consumer);
    delay(KEY_DELAY_MS);
    Consumer.release();
  } else {
    Keyboard.write(k.key);
  }
  delay(KEY_DELAY_MS);
}

/** Escribe texto ASCII. Devuelve cuántos caracteres no ASCII se descartaron. */
int typeText(const String& text) {
  int dropped = 0;
  for (size_t i = 0; i < text.length(); i++) {
    uint8_t c = (uint8_t)text[i];
    if (c == '\n') {
      Keyboard.write(KEY_RETURN);
    } else if (c == '\t') {
      Keyboard.write(KEY_TAB);
    } else if (c == '\r') {
      continue;
    } else if (c >= 0x20 && c < 0x7F) {
      Keyboard.write(c);
    } else if (c >= 0x80) {
      // UTF-8: contar solo el primer byte de cada carácter
      if ((c & 0xC0) != 0x80) dropped++;
      continue;
    } else {
      continue;
    }
    delay(KEY_DELAY_MS);
  }
  return dropped;
}

void clearField() {
  Keyboard.press(KEY_LEFT_CTRL);
  Keyboard.press('a');
  delay(KEY_DELAY_MS);
  Keyboard.releaseAll();
  delay(KEY_DELAY_MS);
  Keyboard.write(KEY_BACKSPACE);
}

// ---------------------------------------------------------------- USB
void onUsbEvent(void* arg, esp_event_base_t base, int32_t id, void* data) {
  if (base == ARDUINO_USB_EVENTS) {
    switch (id) {
      case ARDUINO_USB_STARTED_EVENT:
      case ARDUINO_USB_RESUME_EVENT:
        usbMounted = true;
        break;
      case ARDUINO_USB_STOPPED_EVENT:
      case ARDUINO_USB_SUSPEND_EVENT:
        usbMounted = false;
        break;
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------- HTTP
String jsonEscape(const String& s) {
  String out;
  out.reserve(s.length() + 8);
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if ((uint8_t)c < 0x20) { char b[8]; snprintf(b, sizeof(b), "\\u%04x", c); out += b; }
        else out += c;
    }
  }
  return out;
}

void sendJson(int code, const String& body) {
  server.sendHeader("Cache-Control", "no-store");
  server.send(code, "application/json; charset=utf-8", body);
}

void sendResult(bool ok, int dropped = 0) {
  String j = "{\"ok\":";
  j += ok ? "true" : "false";
  j += ",\"imeAlive\":true,\"editorConnected\":true,\"usbMounted\":";
  j += usbMounted ? "true" : "false";
  if (dropped) { j += ",\"dropped\":"; j += dropped; }
  j += "}";
  sendJson(200, j);
}

void handleRoot() {
  server.sendHeader("Cache-Control", "no-store");
  server.send_P(200, "text/html; charset=utf-8", WEB_PAGE);
}

void handleStatus() {
  bool sta = WiFi.status() == WL_CONNECTED;
  String j = "{\"ok\":true,\"mode\":\"usb\",\"version\":\"" VERSION "\"";
  j += ",\"usbMounted\":"; j += usbMounted ? "true" : "false";
  j += ",\"imeAlive\":true,\"editorConnected\":true,\"accessibility\":true";
  j += ",\"port\":" + String(HTTP_PORT);
  j += ",\"hostname\":\"" HOSTNAME "\"";
  j += ",\"ssid\":\"" + jsonEscape(staSsid) + "\"";
  j += ",\"staConnected\":"; j += sta ? "true" : "false";
  j += ",\"staIp\":\"" + (sta ? WiFi.localIP().toString() : String("")) + "\"";
  j += ",\"ip\":\"" + (sta ? WiFi.localIP().toString() : (apActive ? WiFi.softAPIP().toString() : String(""))) + "\"";
  j += ",\"apActive\":"; j += apActive ? "true" : "false";
  j += ",\"apSsid\":\"" AP_SSID "\"";
  j += ",\"apIp\":\"" + (apActive ? WiFi.softAPIP().toString() : String("")) + "\"";
  j += "}";
  sendJson(200, j);
}

void handleText() {
  String text = server.arg("text");
  int dropped = typeText(text);
  Serial.printf("[text] %d bytes, %d descartados\n", text.length(), dropped);
  sendResult(true, dropped);
}

void handleKey() {
  String name = server.arg("key");
  int count = server.arg("count").toInt();
  if (count < 1) count = 1;
  if (count > 500) count = 500;
  const KeyDef* k = findKey(name);
  if (!k) {
    sendJson(400, "{\"ok\":false,\"error\":\"Tecla desconocida: " + jsonEscape(name) + "\"}");
    return;
  }
  for (int i = 0; i < count; i++) pressKey(*k);
  Serial.printf("[key] %s x%d\n", k->name, count);
  sendResult(true);
}

void handleClear() {
  clearField();
  sendResult(true);
}

void handleWifi() {
  String ssid = server.arg("ssid");
  String pass = server.arg("pass");
  prefs.begin("wifi", false);
  if (ssid.length()) {
    prefs.putString("ssid", ssid);
    prefs.putString("pass", pass);
    Serial.printf("[wifi] guardada red '%s'\n", ssid.c_str());
  } else {
    prefs.clear();
    Serial.println("[wifi] red olvidada");
  }
  prefs.end();
  sendResult(true);
  delay(500);
  ESP.restart();
}

void handleNotFound() {
  sendJson(404, "{\"ok\":false,\"error\":\"No encontrado\"}");
}

// ---------------------------------------------------------------- WiFi
void startWifi() {
  prefs.begin("wifi", true);
  staSsid = prefs.getString("ssid", WIFI_SSID);
  String pass = prefs.getString("pass", WIFI_PASS);
  prefs.end();

  WiFi.persistent(false);
  WiFi.setHostname(HOSTNAME);
  WiFi.mode(WIFI_AP_STA);

  // Red propia: siempre disponible como respaldo (o hasta conectar a casa si AP_ALWAYS = 0).
  apActive = WiFi.softAP(AP_SSID, AP_PASS);
  Serial.printf("[wifi] red propia '%s' -> http://%s\n", AP_SSID, WiFi.softAPIP().toString().c_str());

  if (staSsid.length()) {
    Serial.printf("[wifi] conectando a '%s'...\n", staSsid.c_str());
    WiFi.begin(staSsid.c_str(), pass.c_str());
    unsigned long t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < STA_TIMEOUT_MS) {
      delay(250);
      Serial.print('.');
    }
    Serial.println();
    if (WiFi.status() == WL_CONNECTED) {
      Serial.printf("[wifi] conectado -> http://%s  (http://%s.local)\n",
                    WiFi.localIP().toString().c_str(), HOSTNAME);
#if !AP_ALWAYS
      WiFi.softAPdisconnect(true);
      WiFi.mode(WIFI_STA);
      apActive = false;
#endif
    } else {
      Serial.println("[wifi] no se pudo conectar; usa la red propia para configurar.");
    }
  } else {
    Serial.println("[wifi] sin red configurada; conéctate a la red propia y configúrala en la página.");
  }

  if (MDNS.begin(HOSTNAME)) {
    MDNS.addService("http", "tcp", HTTP_PORT);
  }
}

// ---------------------------------------------------------------- setup / loop
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\nTeclado Remoto USB " VERSION);

  USB.onEvent(onUsbEvent);
  USB.manufacturerName("Tracco");
  USB.productName("Teclado Remoto");
  Keyboard.begin();
  Consumer.begin();
  USB.begin();

  startWifi();

  server.on("/", HTTP_GET, handleRoot);
  server.on("/index.html", HTTP_GET, handleRoot);
  server.on("/api/status", HTTP_GET, handleStatus);
  server.on("/api/text", HTTP_POST, handleText);
  server.on("/api/key", HTTP_POST, handleKey);
  server.on("/api/clear", HTTP_POST, handleClear);
  server.on("/api/wifi", HTTP_POST, handleWifi);
  server.onNotFound(handleNotFound);
  server.begin();
  Serial.println("[http] servidor listo");
}

void loop() {
  server.handleClient();

  // Reintentar la conexión a casa cada 30 s si se perdió.
  if (staSsid.length() && WiFi.status() != WL_CONNECTED && millis() - lastReconnect > 30000) {
    lastReconnect = millis();
    WiFi.reconnect();
  }
}
