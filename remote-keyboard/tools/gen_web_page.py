#!/usr/bin/env python3
"""Convierte app/src/main/assets/index.html en esp32-usb/TecladoRemotoUSB/web_page.h.

Así la página que sirve el ESP32 es exactamente la misma que la de la app Android.
Uso:  python3 tools/gen_web_page.py
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "app", "src", "main", "assets", "index.html")
DST = os.path.join(HERE, "..", "esp32-usb", "TecladoRemotoUSB", "web_page.h")

html = open(SRC, encoding="utf-8").read()
DELIM = "~~~"
assert (")" + DELIM + '"') not in html, "el HTML contiene el delimitador del raw string"

with open(DST, "w", encoding="utf-8") as f:
    f.write("// GENERADO por tools/gen_web_page.py a partir de app/src/main/assets/index.html — no editar a mano.\n")
    f.write("#pragma once\n#include <pgmspace.h>\n\n")
    f.write('static const char WEB_PAGE[] PROGMEM = R"' + DELIM + "(" + html + ")" + DELIM + '";\n')
print("escrito", os.path.relpath(DST, os.path.join(HERE, "..")), "(%d bytes)" % len(html))
