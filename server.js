const express = require('express');
const PDFDocument = require('pdfkit');
const XLSX = require('xlsx');
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

function obtenerRegistrosUsuario(email, usuarios, registros) {
  const emailNormalizado = normalizarTexto(email).toLowerCase();
  const usuario = usuarios.find(
    u => normalizarTexto(obtenerPrimerValor(u, ['email', 'Email'])).toLowerCase() === emailNormalizado
  );

  if (!usuario) return { usuario: null, misRegistros: [] };

  const telefonosUsuario = obtenerTelefonosCandidatos(usuario);
  const misRegistros = registros.filter(r => {
    const telefonoRegistro = obtenerPrimerValor(r, ['Telefono', 'telefono', 'Teléfono', 'TELÉFONO']);
    return telefonosCoinciden(telefonoRegistro, telefonosUsuario);
  });

  return { usuario, misRegistros };
}

function convertirNumero(valor) {
  const numero = Number(String(valor || '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(numero) ? numero : 0;
}

function formatearMoneda(valor) {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0
  }).format(valor);
}

function convertirFechaExcel(valor) {
  const fecha = new Date(valor);
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

function construirWorksheetExcel(registros) {
  const encabezados = ['Fecha', 'Tipo', 'Categoría', 'Descripción', 'Valor'];
  const filas = registros.map(registro => [
    convertirFechaExcel(obtenerPrimerValor(registro, ['Fecha', 'fecha'])) ||
      obtenerPrimerValor(registro, ['Fecha', 'fecha']),
    obtenerPrimerValor(registro, ['Tipo', 'tipo']),
    obtenerPrimerValor(registro, ['Categoria', 'Categoría', 'categoria']),
    obtenerPrimerValor(registro, ['Descripcion', 'Descripción', 'descripcion']),
    convertirNumero(registro.Valor)
  ]);

  const ws = XLSX.utils.aoa_to_sheet([encabezados, ...filas], { cellDates: true });

  for (let index = 0; index < filas.length; index += 1) {
    const cellRef = XLSX.utils.encode_cell({ r: index + 1, c: 0 });
    const cell = ws[cellRef];
    if (cell && cell.v instanceof Date) {
      cell.z = 'dd/mm/yyyy';
    }
  }

  ws['!cols'] = [
    { wch: 14 },
    { wch: 14 },
    { wch: 24 },
    { wch: 42 },
    { wch: 14 }
  ];

  return ws;
}

function generarPdfInforme(res, nombre, registros) {
  const totales = { Ingreso: 0, Gasto: 0, Ahorro: 0, Inversión: 0 };
  registros.forEach(registro => {
    const tipo = obtenerPrimerValor(registro, ['Tipo', 'tipo']);
    totales[tipo] = (totales[tipo] || 0) + convertirNumero(registro.Valor);
  });

  const balance = totales.Ingreso - totales.Gasto;
  const doc = new PDFDocument({ margin: 50, size: 'A4' });

  res.setHeader('Content-Disposition', 'attachment; filename="mi_informe.pdf"');
  res.setHeader('Content-Type', 'application/pdf');
  doc.pipe(res);

  doc.fontSize(22).text('Informe de registros', { align: 'center' });
  doc.moveDown(0.4);
  doc.fontSize(14).text(nombre, { align: 'center' });
  doc.moveDown();
  doc.fontSize(11).fillColor('#555').text(`Total de movimientos: ${registros.length}`);
  doc.text(`Ingresos: ${formatearMoneda(totales.Ingreso)}`);
  doc.text(`Gastos: ${formatearMoneda(totales.Gasto)}`);
  doc.text(`Ahorros: ${formatearMoneda(totales.Ahorro)}`);
  doc.text(`Inversiones: ${formatearMoneda(totales.Inversión)}`);
  doc.text(`Balance neto: ${formatearMoneda(balance)}`);
  doc.moveDown();

  doc.fillColor('#111').fontSize(13).text('Ultimos registros');
  doc.moveDown(0.5);

  const recientes = registros.slice(-20).reverse();
  recientes.forEach((registro, index) => {
    const fecha = obtenerPrimerValor(registro, ['Fecha', 'fecha']);
    const tipo = obtenerPrimerValor(registro, ['Tipo', 'tipo']);
    const categoria = obtenerPrimerValor(registro, ['Categoria', 'Categoría', 'categoria']);
    const descripcion = obtenerPrimerValor(registro, ['Descripcion', 'Descripción', 'descripcion']) || '-';
    const valor = formatearMoneda(convertirNumero(registro.Valor));

    if (doc.y > 720) {
      doc.addPage();
    }

    doc.fontSize(10).fillColor('#111').text(
      `${index + 1}. ${fecha} | ${tipo} | ${categoria} | ${valor}`
    );
    doc.fontSize(9).fillColor('#666').text(`   ${descripcion}`);
    doc.moveDown(0.4);
  });

  doc.end();
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
    const { usuario } = obtenerRegistrosUsuario(email, usuarios, []);

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
    const usuarios = await leerUsuarios();
    const registros = await leerRegistros();
    const { usuario, misRegistros } = obtenerRegistrosUsuario(email, usuarios, registros);
    if (!usuario) return res.status(404).json({ mensaje: 'Usuario no encontrado.' });

    if (misRegistros.length === 0) {
      return res.status(404).json({ mensaje: 'No tienes registros disponibles.' });
    }

    const wb = XLSX.utils.book_new();
    const ws = construirWorksheetExcel(misRegistros);
    XLSX.utils.book_append_sheet(wb, ws, 'Mis Registros');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellDates: true });

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
    const usuarios = await leerUsuarios();
    const registros = await leerRegistros();
    const { usuario, misRegistros } = obtenerRegistrosUsuario(email, usuarios, registros);
    if (!usuario) return res.status(404).json({ mensaje: 'Usuario no encontrado.' });

    if (misRegistros.length === 0) {
      return res.status(404).json({ mensaje: 'No tienes registros disponibles.' });
    }

    const nombre = `${usuario.Nombre || ''} ${usuario.Apellidos || ''}`.trim();
    generarPdfInforme(res, nombre, misRegistros);
  } catch (err) {
    console.error(err);
    res.status(500).json({ mensaje: 'Error al generar el PDF.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en http://localhost:${PORT}`));
