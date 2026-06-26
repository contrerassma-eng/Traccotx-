# Tracco Tx

Automatización tributaria contra el **SII (Servicio de Impuestos Internos)** de Chile.

El proyecto se construye por pruebas incrementales. Cada pieza se valida antes de
montar la siguiente encima:

1. **Prueba 1 — Autenticación con certificado** ✅ (carpeta [`auth/`](auth/))
   La prueba de fuego: leer el certificado `.pfx`, pedir una *semilla* al SII,
   firmarla y obtener un **TOKEN** de sesión. Si el SII entrega el token, el
   certificado autentica y el resto de la arquitectura web es viable.
2. **Bóveda** — _pendiente_ (almacenamiento seguro del certificado / credenciales).
3. **F29** — _pendiente_ (declaración mensual).
4. **Formulario 1866** — _pendiente_.

## Estructura

```
auth/              Prueba 1: autenticación SII (semilla → firma → token)
  pfx.js           Lee el .pfx (PKCS#12) → llave privada + certificado en PEM
  sii-auth.js      Flujo SII: pedir semilla, firmar (XML-DSig SHA1), pedir token
  test-auth.js     Script ejecutable de la prueba de fuego
  package.json     Dependencias (node-forge, xml-crypto, @xmldom/xmldom)
  LEEME.txt        Instrucciones paso a paso para correr la prueba en Windows
```

## Cómo correr la Prueba 1

Ver instrucciones detalladas en [`auth/LEEME.txt`](auth/LEEME.txt). En resumen,
desde la carpeta `auth/` con Node instalado:

```bash
npm install
node test-auth.js "ruta/al/certificado.pfx"
```

La clave del certificado se pide en pantalla y **no se guarda en ningún archivo**.

## Seguridad

- **Nunca** se versiona el certificado ni la clave: el `.gitignore` bloquea
  `*.pfx`, `*.p12`, `*.pem`, `*.key`, `.env` y similares.
- La clave del certificado se solicita interactivamente en cada ejecución.
- No hay datos personales en el código (RUT, nombre ni usuario). El RUT para la
  prueba opcional del RCV se entrega por variable de entorno:
  `RUT=12345678-9 node test-auth.js`. Si no se define, esa prueba se omite.
- El TOKEN del SII caduca en minutos; aun así no debe pegarse en sitios públicos.

## Notas técnicas

- Endpoints de producción del SII (`palena.sii.cl`). Para certificación/pruebas
  existe el ambiente `maullin.sii.cl`.
- La firma de la semilla usa XML-DSig *enveloped* con RSA-SHA1, como exige el SII.
