# TRACCO TX — HANDOFF TÉCNICO

> App 100% en Supabase Edge (Deno) que recupera el **Impuesto Específico al Petróleo Diésel (IEPD)** del SII, mes a mes, para declararlo en el F29. Sin instalar nada, desde el navegador (móvil).

Última actualización: 26-jun-2026. Función desplegada: **v8**.

> Nota: este documento fue depurado de datos personales (RUT, nombre, correo).
> Donde aparezca `<RUT_CONTRIBUYENTE>`, `<TITULAR>` o `<ADMIN_EMAIL>` va el valor
> real, que NO se versiona: vive en los secretos de Supabase, no en el repo.

---

## 0. RESUMEN EN UNA PANTALLA

**Para quién:** el contribuyente `<TITULAR>` — RUT `<RUT_CONTRIBUYENTE>`, persona natural, transporte de carga. Renta efectiva, emite facturas con IVA, paga PPM.

**Qué hace la función hoy, en una sola corrida:**
1. Lee el certificado digital desde Supabase Storage y **autentica contra el SII** (token). ✅ CONFIRMADO
2. Baja las **compras del periodo** desde el RCV y extrae las **facturas de diésel** (IEPD). ✅ CONFIRMADO con datos reales
3. Inicia **sesión con la clave tributaria** en www1, baja el **ZIP de DTE recibidos**, lo descomprime y cruza los **litros por folio**. ⏳ DESPLEGADO, EN PRUEBA (es la parte nueva e incierta)

**El hallazgo de negocio:** el contribuyente NO estaba recuperando ~**$266.000/mes** de crédito IEPD (código 544). Solo enero 2025 ya lo confirmó.

**El límite que define toda la arquitectura:** Claude (en chat) NO tiene red hacia `sii.cl` ni `supabase.co`. Despliega vía MCP; el usuario prueba abriendo la URL en el navegador y pega los logs. Por eso TODO el diagnóstico se hizo "pelando capas" con logs, y por eso TODO devuelve JSON (Supabase free reescribe `text/html`).

---

## 1. ESTADO ACTUAL — QUÉ FUNCIONA Y QUÉ FALTA

### ✅ CONFIRMADO EN PRODUCCIÓN
- **Autenticación SII con certificado.** Cert de Storage → semilla (HTTP 200) → firma `node-forge` (XML-DSig SHA1) → token (HTTP 200). `node-forge` corre en Deno. Titular leído correctamente desde el certificado.
- **Extracción de compras / diésel.** `getDetalleCompraExport` en www4 con el token del cert devuelve HTTP 200. La respuesta viene envuelta en `{"data":[líneas CSV]}` (no array pelado). El diésel se identifica por la columna **"Codigo Otro Impuesto" = 28**, monto en **"Valor Otro Impuesto"**.

### ⏳ DESPLEGADO PERO SIN PROBAR (v8)
- **Login automático con clave + descarga de litros.** Login a `CAutInicio.cgi` → `mipeAdminDocsRcp.cgi` (siembra sesión www1) → `mipeDownLoad.cgi?...&DOWNLOAD=XML` (devuelve un ZIP) → `fflate.unzipSync` → `parseXmlLitros` cruza folio→litros.
  - **Riesgo principal:** el login con clave NUNCA se automatizó antes (la extensión vieja usaba la sesión ya abierta del navegador). Los campos del POST (`rut, dv, referencia, 411, rutcntr, clave`) son la mejor conjetura, no están confirmados contra el SII real.
  - **Qué revisar en los logs:** `Login SII -> HTTP X | cookies:[...]`, `mipeDownLoad -> HTTP X | bytes`, `XML dentro del ZIP: N`, `Litros cruzados: X/6`.
  - **Plan B si el SII bloquea el login automático:** capturar la petición de login una vez desde el navegador (como se hizo con `getDetalleCompraExport`) y replicar headers/cookies exactos; o usar el bucket `dte` (subir XML manual) que ya está implementado como fallback (`leerXmlsLitros`).

---

## 2. INFRAESTRUCTURA SUPABASE

| Recurso | Valor |
|---|---|
| Organización | **Conveyone Spa** — id `nahuunrtqlkcrbqgctkv` |
| Proyecto | **Conveyone Simulator** — ref/id `oiratzlacjskhaxizajb` (ACTIVE_HEALTHY, sa-east-1, PG17) |
| Función | `tracco-auth-test` — `verify_jwt:false` (pública), id `de8550f0-b884-407b-a72c-1fb064709a98` |
| URL | `https://oiratzlacjskhaxizajb.supabase.co/functions/v1/tracco-auth-test?periodo=AAAAMM` |
| Admin | `<ADMIN_EMAIL>` |

> ⚠️ **Slot de proyectos free TOPADO** (2 por admin). Para un proyecto dedicado a Tracco: borrar/repurposar el proyecto "ERP" (id `vcwbpxfzpxpgwumghmsf`, INACTIVE) o hacer upgrade.

> ⚠️ **Seguridad:** la función está como `verify_jwt:false` (pública). Cualquiera con la URL dispara la autenticación al SII y recibe los datos tributarios del contribuyente. Antes de dejarla productiva conviene protegerla (JWT, un token propio en query/header, o restringir por origen).

### Buckets (privados)
- **`certs`** — contiene el certificado `.p12`. La función lo lee con el service role.
- **`dte`** — para XML manual (fallback de litros).

### Secretos (en el dashboard, NO en el repo)
- **`CERT_PASS`** — clave del `.pfx`.
- **`CLAVE_SII`** — clave tributaria del SII.
- **`RUT_CONTRIBUYENTE`** — RUT del contribuyente (formato `12345678-9`).
- `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` los auto-inyecta Supabase.

### Cómo desplegar / debuggear
```bash
# Desde la raíz del repo (contiene supabase/functions/tracco-auth-test/index.ts)
supabase functions deploy tracco-auth-test --no-verify-jwt --project-ref oiratzlacjskhaxizajb

# Logs (o desde el dashboard → Edge Functions → Logs)
supabase functions logs tracco-auth-test --project-ref oiratzlacjskhaxizajb
```
El usuario prueba abriendo la URL en el navegador y pega el JSON (los `logs[]` vienen dentro de la respuesta).

> Nota: para correr local con `supabase functions serve` se necesitan los secretos en un `.env` local (`CERT_PASS`, `CLAVE_SII`, `RUT_CONTRIBUYENTE`) y el cert accesible. Como Storage es remoto, lo más simple es seguir desplegando a la nube y leer logs. Ver `.env.example`.

---

## 3. ARQUITECTURA TÉCNICA VALIDADA

El código vivo está en **`supabase/functions/tracco-auth-test/index.ts`**. Resumen de las piezas:

### 3.1 Autenticación SII (producción, host `palena`)
- **Semilla:** `POST https://palena.sii.cl/DTEWS/CrSeed.jws`, SOAP `getSeed`. Headers `Content-Type: text/xml; charset=utf-8`, `SOAPAction: ""`. Respuesta: XML escapado con `<SEMILLA>`.
- **Token:** `POST https://palena.sii.cl/DTEWS/GetTokenFromSeed.jws`, SOAP `getToken` con `<pszXml><![CDATA[XML_FIRMADO]]></pszXml>`. Respuesta `<TOKEN>`.
- **XML a firmar:** `<getToken><item><Semilla>SEED</Semilla></item></getToken>`. Firma **enveloped SHA1 (RSA-SHA1)**, C14N inclusivo, `Reference URI=""`, dos transforms (enveloped + C14N), KeyInfo X509.
- **Firma con `node-forge` (replica byte a byte lo que hace `xml-crypto`):**
  - `DigestValue = base64(SHA1(canonGetToken))`.
  - `SignedInfo` con `xmlns` agregado y tags expandidos = lo que efectivamente se firma → `SignatureValue = base64(RSA-SHA1-sign)`.
  - API forge: `forge.md.sha1.create()`, `.update(str,'utf8')`, `forge.util.encode64`, `privateKey.sign(md)`.
  - **Decodificar el `.pfx` SIN `Buffer`** (no existe en Deno): `forge.util.decode64` → `forge.asn1.fromDer` → `forge.pkcs12.pkcs12FromAsn1(asn1,false,clave)`. Extraer `pkcs8ShroudedKeyBag.key` y `certBag` → `certificateToPem`.

### 3.2 RCV Compras (host `www4`, sirve el token del cert)
```
POST https://www4.sii.cl/consdcvinternetui/services/data/facadeService/getDetalleCompraExport
Headers:
  Content-Type: application/json
  Accept: application/json, text/plain, */*
  Origin: https://www4.sii.cl
  Referer: https://www4.sii.cl/consdcvinternetui/
  Cookie: TOKEN=<token>; CSESSIONID=<token>
Body:
{
  "metaData": { "namespace": "...FacadeService/getDetalleCompraExport",
                "conversationId": <token>, "transactionId": <uuid>, "page": null },
  "data": { "rutEmisor": "<RUT_SIN_DV>", "dvEmisor": "<DV>", "ptributario": "202501",
            "codTipoDoc": 0, "operacion": "COMPRA", "estadoContab": "REGISTRO",
            "accionRecaptcha": "RCV_DDETC", "tokenRecaptcha": "t-o-k-e-n-web" }
}
```
- **Claves:** `ptributario` es STRING `"AAAAMM"`. El recaptcha **falso funciona**. `operacion:"COMPRA"` + `codTipoDoc:0` son obligatorios.
- **Respuesta:** `{"data":[líneas CSV separadas por ;]}`. Línea[0] = header. Columnas relevantes: `RUT Proveedor`, `Razon Social`, `Folio`, `Fecha Docto`, `Tipo Doc`, **`Codigo Otro Impuesto`** (=28 para IEPD), **`Valor Otro Impuesto`** (=monto IEPD). El parser busca columnas por nombre (resiliente al orden).
- **Ventas (análogo, pendiente):** `getDetalleVentaExport`, `operacion:"VENTA"`.
- `getResumenCompra` da **404** (no existe).

### 3.3 Litros — login con clave + descarga ZIP (host `www1`, parte EN PRUEBA)
Los **litros NO están en el RCV** (es a nivel documento). Solo viven en el XML del DTE, en `<QtyItem>` de la línea de detalle. **El cert NO sirve en www1** (portal MIPYME); www1 requiere **sesión de clave**.

```
# 1) Login
POST https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi   (form-urlencoded)
     rut=<RUT_SIN_DV>, dv=<DV>, referencia=<url www1 mipeAdminDocsRcp>, 411=, rutcntr=<RUT_CONTRIBUYENTE>, clave=<CLAVE_SII>

# 2) Sembrar sesión www1
GET https://www1.sii.cl/cgi-bin/Portal001/mipeAdminDocsRcp.cgi?...&FEC_DESDE=AAAA-MM-01&FEC_HASTA=AAAA-MM-DD&NUM_PAG=1

# 3) Descargar respaldo (devuelve un ZIP con los XML)
GET https://www1.sii.cl/cgi-bin/Portal001/mipeDownLoad.cgi?ORIGEN=RCP&RUT_EMI=&FOLIO=&RZN_SOC=&FEC_DESDE=AAAA-MM-01&FEC_HASTA=AAAA-MM-DD&TPO_DOC=&ESTADO=&ORDEN=&DOWNLOAD=XML
```
- `RUT_EMI` vacío = **todos** los recibidos del rango (tope ~20 docs por descarga).
- La respuesta es un **ZIP** (se detecta por magic bytes `PK` = `0x50 0x4b`). Se descomprime con **`fflate.unzipSync`** → cada `.xml` se pasa a `parseXmlLitros`.
- **Deno no maneja cookie jar:** está implementada la clase `Jar` + `fetchJar` con `redirect:"manual"` que acumula `Set-Cookie` (`headers.getSetCookie()`) y sigue `Location`. Una sola jar para todos los hosts `.sii.cl`.
- **Litros del XML:** `split` por `<Documento`, `<Folio>(\d+)`, sumar `<QtyItem>` de líneas diésel (`NmbItem` ~ /diesel|petróleo/i o `UnmdItem` ~ /^(lt|lts|litro|litros|l)$/). `QtyItem` usa `.` decimal.
- **Riesgo conocido:** el cruce es solo por **folio** (no rut+folio) → posible colisión rara. Mejorar a rut+folio si aparece.

---

## 4. DATOS REALES VALIDADOS (enero 2025, periodo 202501)

| Métrica | Valor |
|---|---|
| Documentos totales en compras | 15 |
| Facturas de diésel (cód. 28) | 6 |
| **IEPD total** | **$332.808** |
| **Crédito código 544 (80%)** | **$266.246** |
| Ejemplo: proveedor combustible | IEPD $195.828 (calza exacto con validación previa) |

Esto confirmó el ~cuarto de millón mensual que el contribuyente no estaba recuperando.

---

## 5. CÓDIGOS F29 Y MAPEO 1866 (para los próximos módulos)

El crédito IEPD se recupera **mes a mes en el F29**:
- **729** = litros / 1000 (dato declarado).
- **744** = componente base = IEPD × % del tramo (**80% hasta 2.400 UF** de ingresos).
- **544** = crédito (lo que se descuenta), va dentro de **537** (total créditos).
- El crédito 544 = **IEPD × 80%** (NO sobre litros).
- Otros: 538 débito (19% de 563), 520 crédito compras, 504 remanente, 563 base PPM, 91 total a pagar.

**Mapeo tipoDTE → tabla 1866:** `{30:1, 33:2, 32:1, 34:2, 46:1, 60:3, 61:4, 55:5, 56:6}`, default 2.

---

## 6. ROADMAP (en orden)

1. **Confirmar/arreglar el login con clave (v8)** → litros automáticos. ← AQUÍ ESTAMOS
2. **Barrido multi-mes** (`?desde=AAAAMM&hasta=AAAAMM`) con total acumulado, para ver la deuda total y qué F29 rectificar.
3. **Bóveda:** tablas en Postgres (compras / ventas / litros / diésel por mes).
4. **Módulos F29 / DJ1866 / DJ1867** que leen de la bóveda.
5. **Ventas** (`getDetalleVentaExport`) para el F29 completo.
6. **Dashboard UI.** Necesita hosting que sirva HTML. El usuario RECHAZÓ Cloudflare Pages. Opciones: Vercel (deploy del usuario) o servir el dashboard también como JSON + un front mínimo.

---

## 7. RIESGOS / COSAS A VIGILAR

- **Login con clave:** lo más frágil. Si el SII responde con la página de login de vuelta (no entra), capturar el POST real desde el navegador (DevTools → Network → `CAutInicio.cgi`) y replicar campos/headers exactos.
- **Cookies cross-subdomain:** la `Jar` manda todas las cookies a todos los hosts `.sii.cl`. Si www1 no acepta la sesión de zeusr, puede faltar un paso intermedio (visitar `mipeLaunchPage.cgi?OPCION=1&TIPO=4` antes de descargar).
- **Tope de 20 docs** en `mipeDownLoad.cgi`: para meses con muchos DTE recibidos habrá que paginar o filtrar por `RUT_EMI` (proveedor de diésel).
- **Token SII caduca en minutos.** Para debug, pedir al usuario solo el detalle de logs, **no el token completo**.
- **Timeout Edge:** login + descarga + unzip + RCV en una sola request. Si da 504, separar litros en una segunda función/endpoint.
- **Deploy vía MCP:** el contenido va inline JSON-escapado; cuidado con los escapes anidados en `firmarSemilla` (`xmlns=\"`) y los regex (`\\s`, `\\d`, `\\u00f3`, `\\.`). Truco para generar el escapado: `node -e` con `JSON.stringify` del archivo.

---

## 8. CÓMO SEGUIR EN CLAUDE CODE

1. Estructura local (ya en este repo):
   ```
   supabase/functions/tracco-auth-test/index.ts   ← código vivo (v8)
   ```
2. `supabase link --project-ref oiratzlacjskhaxizajb` (o usar `--project-ref` en cada deploy).
3. Editar `index.ts`, desplegar con el comando de la sección 2, y pedirle al usuario que abra la URL y pegue los logs. **Iterar pelando capas** (es el método que funcionó: cada paso loguea HTTP + recortes).
4. Cuando los litros estén firmes, avanzar al roadmap (bóveda + módulos F29/1866).

> **El usuario rechazó secuencialmente:** script Node local, extensión Chrome/Tampermonkey, Render, Cloudflare Pages, visor de artefactos. Quiere TODO en Supabase, automático, sin pasos manuales, sin navegador. Trabaja iterativo y preciso, detecta inconsistencias rápido. Español Chile, técnico, directo, sin emojis.

---

## 9. SEGURIDAD

- **Nunca** pegar el certificado ni las claves en sitios públicos ni en el código. El cert vive en el bucket privado `certs` (solo lo lee la función con el service role); las claves en secretos (`CERT_PASS`, `CLAVE_SII`, `RUT_CONTRIBUYENTE`).
- No imprimir la `CLAVE_SII` ni el `CERT_PASS` en los logs.
- El token del SII es efímero; no guardarlo.
- Este repo NO contiene datos personales ni secretos: RUT, nombre y correo están como placeholders y los valores reales viven solo en Supabase.

---

## 10. ARCHIVOS RELACIONADOS

- **`supabase/functions/tracco-auth-test/index.ts`** — código completo de la función (v8).
- **`docs/HANDOFF.md`** — este documento.
- **`.env.example`** — nombres de los secretos/variables (sin valores).
- **`auth/`** — scripts Node de la Prueba 1 original (autenticación standalone), antecesores de la Edge Function.
