# Tracco Tx

Automatización tributaria contra el **SII (Servicio de Impuestos Internos)** de Chile.

App **100% en Supabase Edge (Deno)** que recupera el **Impuesto Específico al
Petróleo Diésel (IEPD)** mes a mes para declararlo en el F29 — sin instalar nada,
desde el navegador. Lee el certificado digital desde Storage, autentica contra el
SII, baja las compras del RCV, identifica las facturas de diésel y cruza los
litros por folio.

> Documento técnico completo y estado al día: **[`docs/HANDOFF.md`](docs/HANDOFF.md)**.

## Estado (v8)

| Etapa | Estado |
|---|---|
| Autenticación SII con certificado (semilla → firma → token) | ✅ Confirmado en producción |
| Compras del RCV + extracción de diésel (IEPD, código 28) | ✅ Confirmado con datos reales |
| Login con clave + descarga ZIP + cruce de litros por folio | ⏳ Desplegado, en prueba |
| Bóveda (Postgres), módulos F29 / DJ1866, ventas, dashboard | ⬜ Pendiente |

**Hallazgo de negocio:** el contribuyente no estaba recuperando ~$266.000/mes de
crédito IEPD (código 544). Confirmado con enero 2025.

## Estructura

```
supabase/functions/tracco-auth-test/index.ts   Edge Function viva (v8): auth + compras + litros
docs/HANDOFF.md                                 Handoff técnico completo (arquitectura, riesgos, roadmap)
auth/                                           Prueba 1 original: scripts Node standalone de autenticación
  pfx.js  sii-auth.js  test-auth.js  package.json  LEEME.txt
.env.example                                    Nombres de secretos/variables (sin valores)
```

> `auth/` son los scripts Node con que se validó la autenticación al inicio. La
> Edge Function de `supabase/` es la evolución que corre todo en la nube (Deno).

## Desplegar la Edge Function

```bash
supabase functions deploy tracco-auth-test --no-verify-jwt --project-ref oiratzlacjskhaxizajb
supabase functions logs   tracco-auth-test --project-ref oiratzlacjskhaxizajb
```

Se prueba abriendo la URL en el navegador (devuelve JSON con `logs[]` dentro):
`https://<project-ref>.supabase.co/functions/v1/tracco-auth-test?periodo=AAAAMM`

## Configuración (secretos en Supabase, NO en el repo)

Ver [`.env.example`](.env.example). Los secretos se configuran en Supabase
(Edge Functions → Secrets):

- `CERT_PASS` — clave del certificado `.pfx`
- `CLAVE_SII` — clave tributaria del SII
- `RUT_CONTRIBUYENTE` — RUT del contribuyente (`12345678-9`)
- El certificado `.p12` vive en el bucket privado `certs` (lo lee el service role).

## Seguridad

- **Nunca** se versionan certificados ni claves: el `.gitignore` bloquea
  `*.pfx`, `*.p12`, `*.pem`, `*.key`, `.env` y similares.
- **No hay datos personales en el repo**: RUT, nombre y correo están como
  placeholders; los valores reales viven solo en los secretos de Supabase.
- ⚠️ La función está como `verify_jwt:false` (pública). Cualquiera con la URL
  recibe los datos tributarios del contribuyente; antes de producción conviene
  protegerla (JWT, token propio, o restricción por origen). Ver `docs/HANDOFF.md` §2.
- El TOKEN del SII caduca en minutos; no debe pegarse en sitios públicos.

## Notas técnicas

- Endpoints de producción del SII (`palena.sii.cl`). Para certificación/pruebas
  existe el ambiente `maullin.sii.cl`.
- La firma de la semilla usa XML-DSig *enveloped* con RSA-SHA1, replicada byte a
  byte con `node-forge` puro (corre en Deno, sin `Buffer`).
