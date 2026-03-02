const express = require('express');
const XLSX = require('xlsx');
const puppeteer = require('puppeteer');
const fs = require('fs/promises');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const USERS_FILE = path.join(__dirname, 'users.json');
const TRANSACTIONS_FILE = path.join(__dirname, 'transactions.json');

function normalizarTexto(valor) {
  return String(valor || '').trim();
}

function normalizarTelefono(valor) {
  return normalizarTexto(valor).replace(/\D/g, '');
}

function normalizarFila(fila) {
  const filaNormalizada = {};
  Object.entries(fila || {}).forEach(([clave, valor]) => {
    filaNormalizada[normalizarTexto(clave)] = normalizarTexto(valor);
  });
  return filaNormalizada;
}

function obtenerPrimerValor(obj, claves) {
  for (const clave of claves) {
    if (obj[clave]) return obj[clave];
  }
  return '';
}

function obtenerTelefonosCandidatos(usuario) {
  const telefonos = [usuario.phone, usuario.numero]
    .map(normalizarTelefono)
    .filter(Boolean);

  const candidatos = new Set();
  telefonos.forEach(telefono => {
    candidatos.add(telefono);
    if (telefono.length > 10) {
      candidatos.add(telefono.slice(-10));
    }
  });

  return Array.from(candidatos);
}

function telefonosCoinciden(telefonoRegistro, telefonosUsuario) {
  const telefonoNormalizado = normalizarTelefono(telefonoRegistro);
  if (!telefonoNormalizado) return false;

  return telefonosUsuario.some(candidato => {
    if (!candidato) return false;
    return (
      telefonoNormalizado === candidato ||
      telefonoNormalizado.endsWith(candidato) ||
      candidato.endsWith(telefonoNormalizado)
    );
  });
}

async function leerJson(rutaArchivo) {
  const contenido = await fs.readFile(rutaArchivo, 'utf8');
  const data = JSON.parse(contenido);
  if (!Array.isArray(data)) {
    throw new Error(`El archivo ${path.basename(rutaArchivo)} no contiene un arreglo JSON.`);
  }
  return data.map(normalizarFila);
}

async function leerUsuarios() {
  return leerJson(USERS_FILE);
}

async function leerRegistros() {
  return leerJson(TRANSACTIONS_FILE);
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── API: verificar email ──
app.post('/api/verificar', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ ok: false, mensaje: 'Email requerido.' });

    const usuarios = await leerUsuarios();
    const emailNormalizado = normalizarTexto(email).toLowerCase();
    const usuario = usuarios.find(u => normalizarTexto(obtenerPrimerValor(u, ['email', 'Email'])).toLowerCase() === emailNormalizado);

    if (!usuario) {
      return res.json({ ok: false, mensaje: 'No encontramos ese correo en nuestros registros.' });
    }

    const nombre = `${usuario.Nombre || ''} ${usuario.Apellidos || ''}`.trim();
    return res.json({ ok: true, nombre, telefono: obtenerPrimerValor(usuario, ['phone', 'numero', 'Phone', 'Numero']) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, mensaje: 'Error al consultar los datos.' });
  }
});

// ── API: descargar Excel ──
app.get('/api/descargar/excel', async (req, res) => {
  try {
    const { email } = req.query;
    const usuarios  = await leerUsuarios();
    const emailNormalizado = normalizarTexto(email).toLowerCase();
    const usuario   = usuarios.find(u => normalizarTexto(obtenerPrimerValor(u, ['email', 'Email'])).toLowerCase() === emailNormalizado);
    if (!usuario) return res.status(404).json({ mensaje: 'Usuario no encontrado.' });

    const telefonosUsuario = obtenerTelefonosCandidatos(usuario);
    const registros = await leerRegistros();
    const misRegistros = registros.filter(r => {
      const telefonoRegistro = obtenerPrimerValor(r, ['Telefono', 'telefono', 'Teléfono', 'TELÉFONO']);
      return telefonosCoinciden(telefonoRegistro, telefonosUsuario);
    });

    if (misRegistros.length === 0) {
      return res.status(404).json({ mensaje: 'No tienes registros disponibles.' });
    }

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(misRegistros);
    XLSX.utils.book_append_sheet(wb, ws, 'Mis Registros');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', 'attachment; filename="mis_registros.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ mensaje: 'Error al generar el Excel.' });
  }
});

// ── API: descargar PDF ──
app.get('/api/descargar/pdf', async (req, res) => {
  try {
    const { email } = req.query;
    const usuarios  = await leerUsuarios();
    const emailNormalizado = normalizarTexto(email).toLowerCase();
    const usuario   = usuarios.find(u => normalizarTexto(obtenerPrimerValor(u, ['email', 'Email'])).toLowerCase() === emailNormalizado);
    if (!usuario) return res.status(404).json({ mensaje: 'Usuario no encontrado.' });

    const telefonosUsuario = obtenerTelefonosCandidatos(usuario);
    const registros = await leerRegistros();
    const misRegistros = registros.filter(r => {
      const telefonoRegistro = obtenerPrimerValor(r, ['Telefono', 'telefono', 'Teléfono', 'TELÉFONO']);
      return telefonosCoinciden(telefonoRegistro, telefonosUsuario);
    });

    if (misRegistros.length === 0) {
      return res.status(404).json({ mensaje: 'No tienes registros disponibles.' });
    }

    const nombre = `${usuario.Nombre || ''} ${usuario.Apellidos || ''}`.trim();
    const htmlInforme = generarHTMLInforme(nombre, misRegistros);

    const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setContent(htmlInforme, { waitUntil: 'networkidle0' });
    await page.waitForTimeout(1500); // esperar que carguen los gráficos

    const pdfBuffer = await page.pdf({
      format: 'A4',
      margin: { top: '20mm', right: '15mm', bottom: '20mm', left: '15mm' },
      printBackground: true
    });

    await browser.close();

    res.setHeader('Content-Disposition', 'attachment; filename="mi_informe.pdf"');
    res.setHeader('Content-Type', 'application/pdf');
    res.send(pdfBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ mensaje: 'Error al generar el PDF.' });
  }
});

// ── Generador del HTML del informe (próximo paso) ──
function generarHTMLInforme(nombre, registros) {
  // Esta función la construimos en la siguiente etapa con gráficos y tablas
  return `<html><body><h1>Informe de ${nombre}</h1><p>${registros.length} registros encontrados.</p></body></html>`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en http://localhost:${PORT}`));
