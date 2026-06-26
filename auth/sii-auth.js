// sii-auth.js — Autenticación ante el SII con certificado digital.
// Flujo oficial: pedir SEMILLA -> firmarla con el certificado -> obtener TOKEN.
// El TOKEN resultante es la llave de sesión para consultar RCV, litros, etc.
const { SignedXml } = require('xml-crypto');
const forge = require('node-forge');

// Endpoints de producción del SII (palena = real; maullin = certificación/pruebas)
const URL_SEMILLA = 'https://palena.sii.cl/DTEWS/CrSeed.jws';
const URL_TOKEN   = 'https://palena.sii.cl/DTEWS/GetTokenFromSeed.jws';

const ALG_C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const ALG_ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
const ALG_RSA_SHA1 = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
const ALG_SHA1 = 'http://www.w3.org/2000/09/xmldsig#sha1';

// Certificado PEM -> base64 plano (sin cabeceras) para el X509Data
function certBase64(certPem) {
  return certPem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
}

// Firma el XML de la semilla segun lo que exige el SII (firma enveloped, SHA1)
function firmarSemilla(semilla, privateKeyPem, certPem) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><getToken><item><Semilla>${semilla}</Semilla></item></getToken>`;

  const sig = new SignedXml({
    privateKey: privateKeyPem,
    signatureAlgorithm: ALG_RSA_SHA1,
    canonicalizationAlgorithm: ALG_C14N,
  });

  sig.addReference({
    xpath: "//*[local-name(.)='getToken']",
    transforms: [ALG_ENVELOPED, ALG_C14N],
    digestAlgorithm: ALG_SHA1,
    uri: '',
    isEmptyUri: true,
  });

  // Incluir el certificado en KeyInfo/X509Data (el SII valida la firma con él)
  const b64 = certBase64(certPem);
  sig.getKeyInfoContent = () => `<X509Data><X509Certificate>${b64}</X509Certificate></X509Data>`;

  sig.computeSignature(xml, {
    location: { reference: "//*[local-name(.)='getToken']", action: 'append' },
  });

  return sig.getSignedXml();
}

// --- Llamadas HTTP al SII (esto solo corre donde haya red hacia sii.cl) ---

function envelopeSemilla() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:def="http://DefaultNamespace">
<soapenv:Header/><soapenv:Body><def:getSeed/></soapenv:Body></soapenv:Envelope>`;
}

function envelopeToken(xmlFirmado) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:def="http://DefaultNamespace">
<soapenv:Header/><soapenv:Body><def:getToken><pszXml><![CDATA[${xmlFirmado}]]></pszXml></def:getToken></soapenv:Body></soapenv:Envelope>`;
}

function entre(texto, etiqueta) {
  const m = texto.match(new RegExp(`<${etiqueta}>([^<]*)</${etiqueta}>`, 'i'));
  return m ? m[1].trim() : null;
}

async function pedirSemilla() {
  const r = await fetch(URL_SEMILLA, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': '' },
    body: envelopeSemilla(),
  });
  const txt = await r.text();
  // La respuesta trae XML escapado; desescapar y extraer la semilla
  const limpio = txt.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  const semilla = entre(limpio, 'SEMILLA');
  if (!semilla) throw new Error('No se pudo leer la SEMILLA. Respuesta SII:\n' + txt.slice(0, 600));
  return semilla;
}

async function pedirToken(xmlFirmado) {
  const r = await fetch(URL_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': '' },
    body: envelopeToken(xmlFirmado),
  });
  const txt = await r.text();
  const limpio = txt.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  const token = entre(limpio, 'TOKEN');
  if (!token) throw new Error('No se pudo leer el TOKEN. Respuesta SII:\n' + txt.slice(0, 600));
  return token;
}

// Orquesta todo: semilla -> firma -> token
async function autenticar(privateKeyPem, certPem) {
  const semilla = await pedirSemilla();
  const firmado = firmarSemilla(semilla, privateKeyPem, certPem);
  const token = await pedirToken(firmado);
  return { semilla, token };
}

module.exports = { firmarSemilla, pedirSemilla, pedirToken, autenticar };
