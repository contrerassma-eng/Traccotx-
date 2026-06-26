// test-auth.js — PRUEBA DE FUEGO: ¿el certificado autentica contra el SII?
// Corre esto en tu PC (tiene red hacia sii.cl). Si imprime un TOKEN, ganamos.
//
//   node test-auth.js
//
// El .pfx debe estar en esta misma carpeta como "certificado.pfx",
// o pasar la ruta:  node test-auth.js "C:\ruta\al\Certificado.pfx"
// La clave se pide en pantalla (no se guarda en ningún archivo).

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { leerPfx } = require('./pfx');
const { pedirSemilla, firmarSemilla, pedirToken } = require('./sii-auth');

// RUT del contribuyente para la prueba extra del RCV (formato 12345678-9).
// Se toma de la variable de entorno RUT; no se hardcodea ningún dato personal.
const RUT = process.env.RUT || '';

function preguntarOculto(texto) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let primero = true;
    rl._writeToOutput = (s) => {
      if (primero) { process.stdout.write(texto); primero = false; }
      // no eco de la clave
    };
    rl.question(texto, (val) => { rl.close(); process.stdout.write('\n'); resolve(val.trim()); });
  });
}

(async () => {
  try {
    // 1) Ubicar el .pfx
    let ruta = process.argv[2] || path.join(__dirname, 'certificado.pfx');
    if (!fs.existsSync(ruta)) {
      console.error('\n✗ No encuentro el certificado en: ' + ruta);
      console.error('  Copia tu .pfx a esta carpeta como "certificado.pfx", o pásalo:');
      console.error('  node test-auth.js "C:\\ruta\\al\\certificado.pfx"\n');
      process.exit(1);
    }

    // 2) Pedir la clave (oculta)
    const clave = await preguntarOculto('Clave del certificado: ');

    // 3) Leer el certificado
    console.log('\n[1/4] Leyendo certificado…');
    const { privateKeyPem, certPem, cn } = leerPfx(ruta, clave);
    console.log('      Titular: ' + (cn || '(sin nombre)'));

    // 4) Pedir semilla
    console.log('[2/4] Pidiendo SEMILLA al SII…');
    const semilla = await pedirSemilla();
    console.log('      Semilla: ' + semilla);

    // 5) Firmar
    console.log('[3/4] Firmando la semilla con el certificado…');
    const firmado = firmarSemilla(semilla, privateKeyPem, certPem);

    // 6) Pedir token
    console.log('[4/4] Pidiendo TOKEN al SII…');
    const token = await pedirToken(firmado);

    console.log('\n========================================');
    console.log('  ✓✓✓  TOKEN OBTENIDO  ✓✓✓');
    console.log('  ' + token);
    console.log('========================================');
    console.log('\nEl certificado AUTENTICA contra el SII. La arquitectura web funciona.');

    // 7) Prueba extra (opcional): ¿el token sirve en el RCV (www4)?
    // Solo se ejecuta si defines la variable de entorno RUT (ej: RUT=12345678-9).
    if (!RUT) {
      console.log('\n[extra] Omitida la prueba del RCV: define RUT=12345678-9 para activarla.');
      console.log('\nListo. Avísame qué imprimió y sigo con la bóveda y el resto.');
      return;
    }
    console.log('\n[extra] Probando si el token sirve en el Registro de Compras y Ventas…');
    try {
      const hoy = new Date();
      const periodo = `${hoy.getFullYear()}${String(hoy.getMonth() === 0 ? 12 : hoy.getMonth()).padStart(2, '0')}`;
      const [rut, dv] = RUT.split('-');
      const r = await fetch('https://www4.sii.cl/consdcvinternetui/services/data/facadeService/getResumenCompra', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cookie': `TOKEN=${token}` },
        body: JSON.stringify({
          metaData: { namespace: 'cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService/getResumenCompra', conversationId: token, transactionId: '' },
          data: { rutEmisorLibro: rut, dvEmisorLibro: dv, ptributario: periodo, codTipoDoc: '', estadoContab: 'REGISTRO' },
        }),
      });
      const txt = await r.text();
      if (r.status === 200 && !/login|autenticac|sesi[oó]n/i.test(txt)) {
        console.log('        ✓ El token TAMBIÉN sirve en el RCV (www4). Bajamos compras/ventas sin problema.');
      } else {
        console.log('        ⚠ El token se obtuvo, pero el RCV respondió raro (status ' + r.status + ').');
        console.log('          Esto lo afinamos; lo importante es que el TOKEN salió.');
      }
    } catch (e) {
      console.log('        ⚠ No se pudo probar el RCV ahora (' + e.message + '). El token sí salió.');
    }

    console.log('\nListo. Avísame qué imprimió y sigo con la bóveda y el resto.');
  } catch (err) {
    console.error('\n✗ ERROR: ' + err.message);
    console.error('\nCopia este error y me lo pasas para corregirlo.');
    process.exit(1);
  }
})();
