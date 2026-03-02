const express = require('express');
const fetch = require('node-fetch');
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

function formatearFechaCorta(valor) {
  const fecha = new Date(valor);
  if (Number.isNaN(fecha.getTime())) return normalizarTexto(valor);
  return new Intl.DateTimeFormat('es-CO', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(fecha);
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

function obtenerClaveMes(fecha) {
  return `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}`;
}

function obtenerEtiquetaMes(fecha) {
  const texto = new Intl.DateTimeFormat('es-CO', {
    month: 'long',
    year: 'numeric'
  }).format(fecha);
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

function crearColores(cantidad) {
  const base = ['#0F766E', '#2563EB', '#F59E0B', '#DC2626', '#7C3AED', '#059669', '#DB2777', '#4F46E5'];
  return Array.from({ length: cantidad }, (_, index) => base[index % base.length]);
}

function calcularResumen(registros) {
  const totales = { Ingreso: 0, Gasto: 0, Ahorro: 0, Inversión: 0 };
  const categorias = {};
  const gastosPorCategoria = {};
  const ingresosPorCategoria = {};

  registros.forEach(registro => {
    const tipo = obtenerPrimerValor(registro, ['Tipo', 'tipo']);
    const categoria = obtenerPrimerValor(registro, ['Categoria', 'Categoría', 'categoria']) || 'Sin categoría';
    const valor = convertirNumero(registro.Valor);

    totales[tipo] = (totales[tipo] || 0) + valor;
    categorias[categoria] = (categorias[categoria] || 0) + valor;

    if (tipo === 'Gasto') {
      gastosPorCategoria[categoria] = (gastosPorCategoria[categoria] || 0) + valor;
    }

    if (tipo === 'Ingreso') {
      ingresosPorCategoria[categoria] = (ingresosPorCategoria[categoria] || 0) + valor;
    }
  });

  return {
    totales,
    categorias,
    gastosPorCategoria,
    ingresosPorCategoria,
    balance: totales.Ingreso - totales.Gasto
  };
}

function agruparRegistrosPorMes(registros) {
  const grupos = new Map();

  registros.forEach(registro => {
    const fecha = convertirFechaExcel(obtenerPrimerValor(registro, ['Fecha', 'fecha']));
    if (!fecha) return;

    const clave = obtenerClaveMes(fecha);
    if (!grupos.has(clave)) {
      grupos.set(clave, {
        etiqueta: obtenerEtiquetaMes(fecha),
        registros: []
      });
    }
    grupos.get(clave).registros.push(registro);
  });

  return Array.from(grupos.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, valor]) => valor);
}

function construirConfigGraficoPie(titulo, datos) {
  const entradas = Object.entries(datos).filter(([, valor]) => valor > 0).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (entradas.length === 0) return null;

  return {
    type: 'pie',
    data: {
      labels: entradas.map(([label]) => label),
      datasets: [
        {
          data: entradas.map(([, valor]) => valor),
          backgroundColor: crearColores(entradas.length)
        }
      ]
    },
    options: {
      plugins: {
        legend: { position: 'bottom' },
        title: { display: true, text: titulo }
      }
    }
  };
}

function construirConfigGraficoDona(titulo, datos) {
  const entradas = Object.entries(datos).filter(([, valor]) => valor > 0).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (entradas.length === 0) return null;

  return {
    type: 'doughnut',
    data: {
      labels: entradas.map(([label]) => label),
      datasets: [
        {
          data: entradas.map(([, valor]) => valor),
          backgroundColor: crearColores(entradas.length)
        }
      ]
    },
    options: {
      cutoutPercentage: 58,
      plugins: {
        legend: { position: 'bottom' },
        title: { display: true, text: titulo }
      }
    }
  };
}

function construirConfigDistribucionIngresos(resumen) {
  const ingreso = resumen.totales.Ingreso;
  if (!ingreso) return null;

  const ahorro = resumen.totales.Ahorro;
  const inversion = resumen.totales.Inversión;
  const resto = Math.max(ingreso - ahorro - inversion, 0);

  return construirConfigGraficoDona('Uso del ingreso total', {
    Ahorro: ahorro,
    Inversión: inversion,
    Disponible: resto
  });
}

async function obtenerImagenGrafico(config) {
  if (!config) return null;

  const url = `https://quickchart.io/chart?width=900&height=520&format=png&backgroundColor=white&c=${encodeURIComponent(JSON.stringify(config))}`;

  try {
    const respuesta = await fetch(url);
    if (!respuesta.ok) return null;
    return respuesta.buffer();
  } catch (error) {
    console.error('Error al cargar gráfico desde QuickChart:', error);
    return null;
  }
}

function asegurarEspacio(doc, altoNecesario) {
  const limite = doc.page.height - doc.page.margins.bottom;
  if (doc.y + altoNecesario > limite) {
    doc.addPage();
  }
}

function dibujarPortada(doc, nombre, totalRegistros) {
  doc.rect(0, 0, doc.page.width, 170).fill('#0F172A');
  doc.fillColor('#F8FAFC').fontSize(26).text('Informe financiero', 50, 55);
  doc.fontSize(15).fillColor('#CBD5E1').text(nombre, 50, 92);
  doc.fontSize(11).text(`Movimientos analizados: ${totalRegistros}`, 50, 118);
  doc.moveDown(6);
}

function dibujarTarjetasResumen(doc, resumen) {
  const tarjetas = [
    { titulo: 'Ingresos', valor: resumen.totales.Ingreso, color: '#DCFCE7', borde: '#22C55E' },
    { titulo: 'Gastos', valor: resumen.totales.Gasto, color: '#FEE2E2', borde: '#EF4444' },
    { titulo: 'Ahorro', valor: resumen.totales.Ahorro, color: '#DBEAFE', borde: '#2563EB' },
    { titulo: 'Inversión', valor: resumen.totales.Inversión, color: '#FCE7F3', borde: '#DB2777' }
  ];

  const left = doc.page.margins.left;
  const top = doc.y;
  const width = (doc.page.width - left - doc.page.margins.right - 16) / 2;
  const height = 74;

  tarjetas.forEach((tarjeta, index) => {
    const x = left + (index % 2) * (width + 16);
    const y = top + Math.floor(index / 2) * (height + 12);

    doc.roundedRect(x, y, width, height, 10).fillAndStroke(tarjeta.color, tarjeta.borde);
    doc.fillColor('#0F172A').fontSize(10).text(tarjeta.titulo, x + 14, y + 14);
    doc.fontSize(14).text(formatearMoneda(tarjeta.valor), x + 14, y + 34, { width: width - 28 });
  });

  doc.y = top + (height * 2) + 24;
}

function dibujarResumenCategorias(doc, resumen) {
  const categorias = Object.entries(resumen.categorias)
    .filter(([, valor]) => valor > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (categorias.length === 0) return;

  asegurarEspacio(doc, 110);
  doc.fillColor('#0F172A').fontSize(14).text('Totales por categoría');
  doc.moveDown(0.4);

  categorias.forEach(([categoria, valor]) => {
    doc.fontSize(10).fillColor('#334155').text(`${categoria}: ${formatearMoneda(valor)}`);
  });

  doc.moveDown();
}

function dibujarPlaceholderGrafico(doc, titulo) {
  asegurarEspacio(doc, 180);
  doc.fillColor('#0F172A').fontSize(12).text(titulo);
  doc.moveDown(0.3);
  const x = doc.page.margins.left;
  const y = doc.y;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.roundedRect(x, y, width, 150, 10).stroke('#CBD5E1');
  doc.fillColor('#64748B').fontSize(10).text('No fue posible cargar este gráfico.', x, y + 68, {
    width,
    align: 'center'
  });
  doc.y = y + 166;
}

function dibujarImagenGrafico(doc, titulo, imageBuffer) {
  if (!imageBuffer) {
    dibujarPlaceholderGrafico(doc, titulo);
    return;
  }

  asegurarEspacio(doc, 250);
  doc.fillColor('#0F172A').fontSize(12).text(titulo);
  doc.moveDown(0.3);
  const x = doc.page.margins.left;
  const y = doc.y;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.image(imageBuffer, x, y, { fit: [width, 210], align: 'center' });
  doc.y = y + 220;
}

async function dibujarSeccionResumen(doc, titulo, subtitulo, registros) {
  const resumen = calcularResumen(registros);
  const graficos = await Promise.all([
    obtenerImagenGrafico(construirConfigGraficoPie('Gastos por categoría', resumen.gastosPorCategoria)),
    obtenerImagenGrafico(construirConfigGraficoDona('Ingresos por categoría', resumen.ingresosPorCategoria)),
    obtenerImagenGrafico(construirConfigDistribucionIngresos(resumen))
  ]);

  asegurarEspacio(doc, 120);
  doc.fillColor('#0F172A').fontSize(18).text(titulo);
  if (subtitulo) {
    doc.moveDown(0.2);
    doc.fontSize(10).fillColor('#64748B').text(subtitulo);
  }
  doc.moveDown(0.8);

  dibujarTarjetasResumen(doc, resumen);

  doc.fillColor('#334155').fontSize(10).text(`Balance neto: ${formatearMoneda(resumen.balance)}`);
  doc.text(`Movimientos incluidos: ${registros.length}`);
  doc.moveDown();

  dibujarResumenCategorias(doc, resumen);
  dibujarImagenGrafico(doc, 'Distribución de gastos por categoría', graficos[0]);
  dibujarImagenGrafico(doc, 'Distribución de ingresos por categoría', graficos[1]);
  dibujarImagenGrafico(doc, 'Del ingreso total: ahorro vs inversión', graficos[2]);
}

async function generarPdfInforme(res, nombre, registros) {
  const doc = new PDFDocument({ margin: 45, size: 'A4' });
  const registrosOrdenados = [...registros].sort((a, b) => {
    const fechaA = convertirFechaExcel(obtenerPrimerValor(a, ['Fecha', 'fecha']));
    const fechaB = convertirFechaExcel(obtenerPrimerValor(b, ['Fecha', 'fecha']));
    return (fechaA?.getTime() || 0) - (fechaB?.getTime() || 0);
  });
  const meses = agruparRegistrosPorMes(registrosOrdenados);

  res.setHeader('Content-Disposition', 'attachment; filename="mi_informe.pdf"');
  res.setHeader('Content-Type', 'application/pdf');
  doc.pipe(res);

  dibujarPortada(doc, nombre, registrosOrdenados.length);
  await dibujarSeccionResumen(
    doc,
    'Resumen general',
    registrosOrdenados.length
      ? `Periodo analizado: ${formatearFechaCorta(obtenerPrimerValor(registrosOrdenados[0], ['Fecha']))} al ${formatearFechaCorta(obtenerPrimerValor(registrosOrdenados[registrosOrdenados.length - 1], ['Fecha']))}`
      : '',
    registrosOrdenados
  );

  for (let index = 0; index < meses.length; index += 1) {
    doc.addPage();
    const mes = meses[index];
    await dibujarSeccionResumen(doc, mes.etiqueta, 'Resumen mensual', mes.registros);
  }

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
    await generarPdfInforme(res, nombre, misRegistros);
  } catch (err) {
    console.error(err);
    res.status(500).json({ mensaje: 'Error al generar el PDF.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en http://localhost:${PORT}`));
