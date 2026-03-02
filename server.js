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

function formatearPorcentaje(valor) {
  return `${new Intl.NumberFormat('es-CO', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  }).format(valor)}%`;
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

function resumirEntradas(datos, limite) {
  const entradas = Object.entries(datos)
    .filter(([, valor]) => valor > 0)
    .sort((a, b) => b[1] - a[1]);

  if (entradas.length <= limite) return entradas;

  const visibles = entradas.slice(0, limite - 1);
  const resto = entradas.slice(limite - 1).reduce((acc, [, valor]) => acc + valor, 0);
  return [...visibles, ['Otras categorías', resto]];
}

function construirModeloGrafico(tipo, datos, opciones = {}) {
  const entradas = resumirEntradas(datos, 6);
  if (entradas.length === 0) return null;

  const total = entradas.reduce((acc, [, valor]) => acc + valor, 0);
  const colors = crearColores(entradas.length);

  return {
    leyenda: entradas.map(([label, valor], index) => ({
      label,
      valor,
      porcentaje: total ? (valor / total) * 100 : 0,
      color: colors[index]
    })),
    config: {
      type: tipo,
      data: {
        labels: entradas.map(([label]) => label),
        datasets: [
          {
            data: entradas.map(([, valor]) => valor),
            backgroundColor: colors,
            borderColor: '#FFFFFF',
            borderWidth: 2
          }
        ]
      },
      options: {
        animation: false,
        legend: { display: false },
        layout: {
          padding: 8
        },
        cutoutPercentage: opciones.cutoutPercentage,
        plugins: {
          legend: { display: false },
          title: { display: false },
          datalabels: { display: false }
        }
      }
    }
  };
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
  return construirModeloGrafico('pie', datos);
}

function construirConfigGraficoDona(titulo, datos) {
  return construirModeloGrafico('doughnut', datos, { cutoutPercentage: 58 });
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

  const url = `https://quickchart.io/chart?width=700&height=420&format=png&backgroundColor=white&c=${encodeURIComponent(JSON.stringify(config))}`;

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

function dibujarEncabezadoSeccion(doc, nombre, titulo, subtitulo, totalRegistros) {
  const x = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.roundedRect(x, 36, width, 94, 14).fill('#0F172A');
  doc.fillColor('#F8FAFC').fontSize(22).text(titulo, x + 22, 56, { width: width - 44 });
  doc.fontSize(11).fillColor('#CBD5E1').text(nombre, x + 22, 86, { width: width - 44 });
  doc.fontSize(10).fillColor('#94A3B8').text(`${subtitulo}  |  Movimientos: ${totalRegistros}`, x + 22, 104, {
    width: width - 44
  });
  doc.y = 148;
}

function dibujarTarjetasResumen(doc, resumen) {
  const tarjetas = [
    { titulo: 'Ingresos', valor: resumen.totales.Ingreso, color: '#ECFDF5', borde: '#10B981' },
    { titulo: 'Gastos', valor: resumen.totales.Gasto, color: '#FEF2F2', borde: '#EF4444' },
    { titulo: 'Ahorro', valor: resumen.totales.Ahorro, color: '#EFF6FF', borde: '#2563EB' },
    { titulo: 'Inversión', valor: resumen.totales.Inversión, color: '#FDF2F8', borde: '#DB2777' }
  ];

  const left = doc.page.margins.left;
  const top = doc.y;
  const gap = 8;
  const width = (doc.page.width - left - doc.page.margins.right - (gap * 3)) / 4;
  const height = 54;

  tarjetas.forEach((tarjeta, index) => {
    const x = left + index * (width + gap);
    const y = top;

    doc.roundedRect(x, y, width, height, 12).fillAndStroke(tarjeta.color, tarjeta.borde);
    doc.fillColor('#334155').fontSize(9).text(tarjeta.titulo, x + 14, y + 13);
    doc.fillColor('#0F172A').fontSize(13).text(formatearMoneda(tarjeta.valor), x + 14, y + 31, {
      width: width - 28
    });
  });

  doc.y = top + height + 14;
}

function dibujarCajaPanel(doc, x, y, width, height, titulo) {
  doc.roundedRect(x, y, width, height, 12).fillAndStroke('#FFFFFF', '#D6DEE8');
  doc.roundedRect(x, y, width, 30, 12).fill('#F8FAFC');
  doc.rect(x, y + 18, width, 12).fill('#F8FAFC');
  doc.fillColor('#0F172A').fontSize(11).text(titulo, x + 12, y + 10, {
    width: width - 24
  });
}

function dibujarTablaCategoriasPanel(doc, x, y, width, height, resumen) {
  dibujarCajaPanel(doc, x, y, width, height, 'Totales por categoría');

  const filas = resumirEntradas(resumen.categorias, 8);
  const inicioY = y + 40;
  const filaAlto = 18;
  const areaY = y + height - 24;
  const maxFilas = Math.max(1, Math.floor((areaY - inicioY) / filaAlto));
  const visibles = filas.slice(0, maxFilas);

  if (visibles.length === 0) {
    doc.fillColor('#64748B').fontSize(9).text('Sin movimientos en categorías.', x + 12, inicioY + 10);
    return;
  }

  doc.roundedRect(x + 10, inicioY, width - 20, filaAlto, 6).fill('#E2E8F0');
  doc.fillColor('#334155').fontSize(8).text('Categoría', x + 16, inicioY + 5, { width: width * 0.52 });
  doc.text('Total', x + width * 0.56, inicioY + 5, { width: width * 0.3, align: 'right' });

  visibles.forEach(([categoria, valor], index) => {
    const rowY = inicioY + filaAlto + index * filaAlto;
    if (rowY + filaAlto > y + height - 10) return;

    if (index % 2 === 0) {
      doc.roundedRect(x + 10, rowY, width - 20, filaAlto, 4).fill('#F8FAFC');
    }
    doc.fillColor('#0F172A').fontSize(8.5).text(categoria, x + 16, rowY + 5, {
      width: width * 0.5,
      ellipsis: true
    });
    doc.text(formatearMoneda(valor), x + width * 0.5, rowY + 5, {
      width: width * 0.34,
      align: 'right'
    });
  });
}

function dibujarLeyendaGrafico(doc, x, y, width, height, leyenda) {
  const inicioY = y + 6;
  const filaAlto = 18;
  const disponibles = Math.max(1, Math.floor((height - 6) / filaAlto));
  const visibles = (leyenda || []).slice(0, disponibles);

  if (visibles.length === 0) {
    doc.fillColor('#64748B').fontSize(8.5).text('Sin datos', x, inicioY + 8, { width });
    return;
  }

  doc.fillColor('#334155').fontSize(8).text('Categoría', x + 16, inicioY, { width: width * 0.62 });
  doc.text('%', x + width * 0.72, inicioY, { width: width * 0.2, align: 'right' });

  visibles.forEach((item, index) => {
    const rowY = inicioY + 14 + index * filaAlto;
    doc.circle(x + 6, rowY + 5, 4).fill(item.color);
    doc.fillColor('#0F172A').fontSize(8.2).text(item.label, x + 16, rowY, {
      width: width * 0.6,
      ellipsis: true
    });
    doc.text(formatearPorcentaje(item.porcentaje), x + width * 0.68, rowY, {
      width: width * 0.24,
      align: 'right'
    });
  });
}

function dibujarGraficoPanel(doc, x, y, width, height, titulo, grafico) {
  dibujarCajaPanel(doc, x, y, width, height, titulo);
  const bodyY = y + 38;
  const bodyHeight = height - 48;
  const legendWidth = Math.max(118, Math.min(150, width * 0.42));
  const chartWidth = width - legendWidth - 24;
  const legendX = x + 12;
  const chartX = legendX + legendWidth + 12;

  dibujarLeyendaGrafico(doc, legendX, bodyY, legendWidth, bodyHeight, grafico?.leyenda);

  if (!grafico?.imageBuffer) {
    doc.fillColor('#64748B').fontSize(8.5).text('No fue posible cargar este gráfico.', chartX, bodyY + 80, {
      width: chartWidth,
      align: 'center'
    });
    return;
  }

  doc.image(grafico.imageBuffer, chartX, bodyY + 8, {
    fit: [chartWidth, bodyHeight - 12],
    align: 'center',
    valign: 'center'
  });
}

async function dibujarSeccionResumen(doc, nombre, titulo, subtitulo, registros) {
  const resumen = calcularResumen(registros);
  const modelosGraficos = [
    construirConfigGraficoPie('Gastos por categoría', resumen.gastosPorCategoria),
    construirConfigGraficoDona('Ingresos por categoría', resumen.ingresosPorCategoria),
    construirConfigDistribucionIngresos(resumen)
  ];
  const graficos = await Promise.all(
    modelosGraficos.map(async modelo => {
      if (!modelo) return null;
      return {
        ...modelo,
        imageBuffer: await obtenerImagenGrafico(modelo.config)
      };
    })
  );
  const margin = doc.page.margins.left;
  const gap = 14;
  const panelWidth = (doc.page.width - doc.page.margins.left - doc.page.margins.right - gap) / 2;
  const panelHeight = 248;
  const topGrid = 238;

  dibujarEncabezadoSeccion(doc, nombre, titulo, subtitulo, registros.length);
  dibujarTarjetasResumen(doc, resumen);

  doc.fillColor('#334155').fontSize(9.5).text(
    `Balance neto: ${formatearMoneda(resumen.balance)}  |  Último movimiento: ${formatearFechaCorta(
      obtenerPrimerValor(registros[registros.length - 1] || {}, ['Fecha'])
    )}`,
    margin,
    214,
    { width: doc.page.width - margin - doc.page.margins.right }
  );

  dibujarTablaCategoriasPanel(doc, margin, topGrid, panelWidth, panelHeight, resumen);
  dibujarGraficoPanel(doc, margin + panelWidth + gap, topGrid, panelWidth, panelHeight, 'Distribución de gastos', graficos[0]);
  dibujarGraficoPanel(doc, margin, topGrid + panelHeight + gap, panelWidth, panelHeight, 'Distribución de ingresos', graficos[1]);
  dibujarGraficoPanel(
    doc,
    margin + panelWidth + gap,
    topGrid + panelHeight + gap,
    panelWidth,
    panelHeight,
    'Ingreso total: ahorro vs inversión',
    graficos[2]
  );
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

  await dibujarSeccionResumen(
    doc,
    nombre,
    'Resumen general',
    registrosOrdenados.length
      ? `Periodo analizado: ${formatearFechaCorta(obtenerPrimerValor(registrosOrdenados[0], ['Fecha']))} al ${formatearFechaCorta(obtenerPrimerValor(registrosOrdenados[registrosOrdenados.length - 1], ['Fecha']))}`
      : '',
    registrosOrdenados
  );

  for (let index = 0; index < meses.length; index += 1) {
    doc.addPage();
    const mes = meses[index];
    await dibujarSeccionResumen(doc, nombre, mes.etiqueta, 'Resumen mensual', mes.registros);
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
