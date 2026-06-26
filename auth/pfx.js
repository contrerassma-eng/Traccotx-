// pfx.js — lee el certificado .pfx (PKCS#12) y devuelve la llave privada
// y el certificado en formato PEM, listos para firmar la semilla del SII.
const fs = require('fs');
const forge = require('node-forge');

function leerPfx(rutaPfx, clave) {
  const der = fs.readFileSync(rutaPfx, 'binary');
  const asn1 = forge.asn1.fromDer(der);
  const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, clave);

  // Llave privada (puede venir como bag cifrado pkcs8 o sin cifrar)
  let keyBag =
    p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag][0] ||
    p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag][0];
  if (!keyBag || !keyBag.key) throw new Error('No se encontró la llave privada en el .pfx');
  const privateKeyPem = forge.pki.privateKeyToPem(keyBag.key);

  // Certificado
  const certBag = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag][0];
  if (!certBag || !certBag.cert) throw new Error('No se encontró el certificado en el .pfx');
  const cert = certBag.cert;
  const certPem = forge.pki.certificateToPem(cert);

  // Datos del titular (RUT y nombre, para confirmar de quién es)
  const cn = (cert.subject.getField('CN') || {}).value || '';
  let rut = '';
  try {
    const alt = cert.getExtension('subjectAltName');
    if (alt && alt.altNames) {
      for (const n of alt.altNames) {
        const v = (n.value || '').toString();
        const m = v.match(/(\d{7,8}-[\dkK])/);
        if (m) { rut = m[1]; break; }
      }
    }
  } catch (e) {}

  return { privateKeyPem, certPem, cn, rut };
}

module.exports = { leerPfx };
