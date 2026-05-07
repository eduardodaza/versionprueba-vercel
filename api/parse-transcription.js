module.exports.config = {
  api: { bodyParser: { sizeLimit: '2mb' } },
};

// El LLM extrae solo campos estructurados cortos.
// hallazgos se toma directamente del texto transcrito para garantizar literalidad 100%.
const systemPromptManual = `Parser de transcripciones radiológicas. Extrae TODOS los estudios via tool call.

Campos por estudio:
- nombre_paciente, tipo_estudio(TAC o RM), region, lateralidad("derecha"/"izquierda"/"bilateral" o null), es_contrastado(true/false)
- datos_clinicos: indicación/diagnóstico, o ""
- conclusiones: conclusiones/impresión diagnóstica, o ""
- hallazgos: ""
- plantilla_match: null
- nombre_archivo_sugerido: nombre_paciente + tipo_estudio + region
- char_start: posición en caracteres donde empieza este estudio en el texto
- char_end: posición en caracteres donde termina este estudio en el texto

REGLAS:
- Extraer TODOS los estudios sin excepción
- Campos vacíos = "" nunca null`;

const systemPromptAuto = `Parser de transcripciones radiológicas. Extrae TODOS los estudios via tool call.

Campos por estudio:
- nombre_paciente, tipo_estudio(TAC o RM), region, lateralidad("derecha"/"izquierda"/"bilateral" o null), es_contrastado(true/false)
- datos_clinicos: indicación/diagnóstico, o ""
- conclusiones: conclusiones/impresión diagnóstica, o ""
- hallazgos: ""
- plantilla_match: nombre exacto de la lista de plantillas disponibles, o null
- nombre_archivo_sugerido: nombre_paciente + tipo_estudio + region
- char_start: posición en caracteres donde empieza este estudio en el texto
- char_end: posición en caracteres donde termina este estudio en el texto

REGLAS:
- Extraer TODOS los estudios sin excepción
- TAC → solo plantillas con "TAC". RM → solo plantillas con "RM" o "++RM". Nunca mezclar.
- Campos vacíos = "" nunca null`;

function encontrarPlantillaMasCercana(tipoEstudio, region, esContrastado, conclusiones, hallazgos, templateNames) {
  if (!templateNames || templateNames.length === 0) return null;

  const tipo = (tipoEstudio || '').toLowerCase();
  const reg = (region || '').toLowerCase();
  const conc = (conclusiones || '').toLowerCase();
  const hall = (hallazgos || '').toLowerCase();
  const textoCompleto = `${conc} ${hall}`;

  const esRM = tipo.includes('rm') || tipo.includes('resonancia');
  const esTAC = tipo.includes('tac');

  const reglas = [
    { cuando: esRM && reg.includes('hombro') && (textoCompleto.includes('ruptura parcial') || textoCompleto.includes('rotura parcial')),
      buscar: ['hombro', 'parcial'] },
    { cuando: esRM && reg.includes('hombro') && (textoCompleto.includes('ruptura completa') || textoCompleto.includes('rotura completa')),
      buscar: ['hombro', 'completa'] },
    { cuando: esRM && reg.includes('hombro'),
      buscar: ['hombro', 'tendinosis'] },
    { cuando: esRM && reg.includes('rodilla') && (textoCompleto.includes('ruptura') || textoCompleto.includes('rotura') || textoCompleto.includes('desgarro')),
      buscar: ['rodilla', 'lesion'] },
    { cuando: esRM && reg.includes('rodilla'),
      buscar: ['rodilla'] },
    { cuando: esRM && (reg.includes('columna lumbar') || reg.includes('lumbar')),
      buscar: ['lumbar'] },
    { cuando: esRM && (reg.includes('columna cervical') || reg.includes('cervical')),
      buscar: ['cervical'] },
    { cuando: esRM && (reg.includes('columna dorsal') || reg.includes('dorsal')),
      buscar: ['dorsal'] },
    { cuando: esRM && (reg.includes('cerebro') || reg.includes('craneo') || reg.includes('cráneo') || reg.includes('encefalo')),
      buscar: ['cerebro'] },
    { cuando: esRM && reg.includes('abdomen'),
      buscar: ['abdomen'] },
    { cuando: esTAC && reg.includes('abdomen') && !textoCompleto.includes('simple'),
      buscar: ['abdomen', 'contrastado'] },
    { cuando: esTAC && reg.includes('abdomen') && textoCompleto.includes('simple'),
      buscar: ['abdomen'] },
    { cuando: esTAC && (reg.includes('torax') || reg.includes('tórax')) && !textoCompleto.includes('simple'),
      buscar: ['torax', 'contrastado'] },
    { cuando: esTAC && (reg.includes('torax') || reg.includes('tórax')) && textoCompleto.includes('simple'),
      buscar: ['torax'] },
    { cuando: esTAC && (reg.includes('toracoabdominal') || (reg.includes('torax') && reg.includes('abdomen'))),
      buscar: ['toracoabdominal', 'contrastado'] },
    { cuando: esTAC && (reg.includes('hombro') || reg.includes('tobillo') || reg.includes('rodilla') || reg.includes('pie') || reg.includes('mano') || reg.includes('muneca') || reg.includes('muñeca') || reg.includes('cadera') || reg.includes('codo')),
      buscar: ['musculoesqueletico'] },
    { cuando: esTAC && (reg.includes('craneo') || reg.includes('cráneo') || reg.includes('cerebro') || reg.includes('encefalo')),
      buscar: ['craneo'] },
    { cuando: esTAC && reg.includes('lumbar'),
      buscar: ['lumbar'] },
    { cuando: esTAC && reg.includes('cervical'),
      buscar: ['cervical'] },
  ];

  for (const regla of reglas) {
    if (!regla.cuando) continue;
    const candidatas = templateNames.filter(nombre => {
      const n = nombre.toLowerCase();
      return regla.buscar.every(palabra => n.includes(palabra.toLowerCase()));
    });
    if (candidatas.length === 0) continue;
    const conPlusPlus = candidatas.find(n => n.startsWith('++'));
    return conPlusPlus || candidatas[0];
  }

  const regionLimpia = reg
    .replace(/derech[ao]/g, '').replace(/izquierd[ao]/g, '')
    .replace(/bilateral/g, '').trim();
  const palabras = regionLimpia.split(/\s+/).filter(p => p.length > 3);

  const candidatasFallback = templateNames.filter(nombre => {
    const n = nombre.toLowerCase();
    const esModalidadCorrecta = esRM ? (n.includes('rm') || n.includes('++rm')) : esTAC ? n.includes('tac') : true;
    return esModalidadCorrecta && palabras.some(p => n.includes(p));
  });

  if (candidatasFallback.length > 0) {
    const conPlusPlus = candidatasFallback.find(n => n.startsWith('++'));
    return conPlusPlus || candidatasFallback[0];
  }

  return null;
}

const tools = [{
  type: 'function',
  function: {
    name: 'parse_transcription_result',
    description: 'Return ALL parsed studies from the transcription',
    parameters: {
      type: 'object',
      properties: {
        estudios: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              nombre_paciente: { type: 'string' },
              tipo_estudio: { type: 'string' },
              region: { type: 'string' },
              lateralidad: { type: ['string', 'null'] },
              es_contrastado: { type: 'boolean' },
              hallazgos: { type: 'string' },
              conclusiones: { type: 'string' },
              datos_clinicos: { type: 'string' },
              plantilla_match: { type: ['string', 'null'] },
              nombre_archivo_sugerido: { type: 'string' },
              char_start: { type: 'number' },
              char_end: { type: 'number' },
            },
            required: ['nombre_paciente','tipo_estudio','region','lateralidad','es_contrastado','hallazgos','conclusiones','datos_clinicos','plantilla_match','nombre_archivo_sugerido','char_start','char_end'],
            additionalProperties: false,
          },
        },
        estudios_sin_match: { type: 'array', items: { type: 'string' } },
      },
      required: ['estudios', 'estudios_sin_match'],
      additionalProperties: false,
    },
  },
}];

// Extrae hallazgos directamente del texto.
// Estrategia 1: dividir por separadores --- AUDIO --- si existen (más confiable).
// Estrategia 2: usar char_start/char_end del LLM como fallback.
function extraerHallazgosDesdeTexto(transcriptionText, estudios) {
  if (!estudios || estudios.length === 0) return estudios;

  const texto = transcriptionText;

  // Detectar separadores --- AUDIO-xxx --- o --- cualquier texto ---
  const separadorRegex = /---[^\n]+-{2,}/g;
  const separadores = [];
  let match;
  while ((match = separadorRegex.exec(texto)) !== null) {
    separadores.push({ pos: match.index, fin: match.index + match[0].length });
  }

  let fragmentos;

  if (separadores.length > 0) {
    // Estrategia 1: partir el texto por los separadores --- AUDIO ---
    const bloques = [];
    for (let i = 0; i < separadores.length; i++) {
      const inicioBloque = separadores[i].fin;
      const finBloque = i + 1 < separadores.length ? separadores[i + 1].pos : texto.length;
      bloques.push(texto.substring(inicioBloque, finBloque).trim());
    }
    const antePrimero = texto.substring(0, separadores[0].pos).trim();
    if (antePrimero.length > 50) bloques.unshift(antePrimero);
    fragmentos = estudios.map((_, i) => bloques[i] || null);

  } else {
    // Estrategia 2: dividir por párrafos dobles que empiecen con indicador de paciente
    // Cubre texto pegado desde otro editor sin separadores --- AUDIO ---
    const parrafos = texto.split(/\n{2,}/);
    const bloques = [];
    let bloqueActual = '';

    const esInicioEstudio = (p) => {
      const t = p.trim().toLowerCase();
      return t.startsWith('siguiente paciente') ||
             t.startsWith('paciente ') ||
             t.startsWith('el paciente') ||
             t.startsWith('la paciente') ||
             /^[a-záéíóúüñ]+\s+[a-záéíóúüñ]+\s+[a-záéíóúüñ]/.test(t); // nombre propio (3 palabras)
    };

    for (const parrafo of parrafos) {
      if (esInicioEstudio(parrafo) && bloqueActual.length > 100) {
        bloques.push(bloqueActual.trim());
        bloqueActual = parrafo;
      } else {
        bloqueActual += (bloqueActual ? '\n\n' : '') + parrafo;
      }
    }
    if (bloqueActual.trim()) bloques.push(bloqueActual.trim());

    if (bloques.length >= estudios.length) {
      fragmentos = estudios.map((_, i) => bloques[i] || null);
    } else {
      // Fallback: usar char_start/char_end del LLM
      fragmentos = estudios.map((estudio) => {
        const start = typeof estudio.char_start === 'number' ? estudio.char_start : 0;
        const end = typeof estudio.char_end === 'number' ? estudio.char_end : texto.length;
        return texto.substring(Math.max(0, start), Math.min(texto.length, end)).trim();
      });
    }
  }

  return estudios.map((estudio, i) => {
    let fragmento = fragmentos[i] || texto;

    // Quitar conclusiones si aparecen en la segunda mitad
    const conclusionKeywords = ['conclusión', 'conclusion', 'conclusiones', 'impresión diagnóstica', 'impresion diagnostica'];
    for (const kw of conclusionKeywords) {
      const idx = fragmento.toLowerCase().lastIndexOf(kw);
      if (idx > fragmento.length * 0.5) {
        fragmento = fragmento.substring(0, idx).trim();
        break;
      }
    }

    // Quitar datos clínicos si aparecen al inicio
    const datosKeywords = ['datos clínicos', 'datos clinicos', 'indicación', 'indicacion'];
    for (const kw of datosKeywords) {
      const idx = fragmento.toLowerCase().indexOf(kw);
      if (idx !== -1 && idx < 150) {
        const newline = fragmento.indexOf('\n', idx);
        if (newline !== -1) fragmento = fragmento.substring(newline + 1).trim();
        break;
      }
    }

    return { ...estudio, hallazgos: fragmento || texto };
  });
}

module.exports.default = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY)
    return res.status(500).json({ error: 'GROQ_API_KEY no configurado' });

  const { transcriptionText, templateNames, modoManual } = req.body || {};
  if (!transcriptionText)
    return res.status(400).json({ error: 'Se requiere transcriptionText' });

  try {
    let systemFinal;

    if (modoManual) {
      systemFinal = systemPromptManual;
    } else {
      const textoLower = transcriptionText.toLowerCase();
      const esTAC = textoLower.includes('tac');
      const esRM = textoLower.includes(' rm ') || textoLower.includes('resonancia');

      const plantillasFiltradas = (templateNames || []).filter(nombre => {
        const n = nombre.toLowerCase();
        if (esTAC && !esRM) return n.includes('tac');
        if (esRM && !esTAC) return n.includes('rm') || n.includes('++rm');
        return true;
      });

      const plantillasAUsar = plantillasFiltradas.length >= 3
        ? plantillasFiltradas
        : (templateNames || []);

      systemFinal = `${systemPromptAuto}\n\nPLANTILLAS:\n${plantillasAUsar.join('\n')}`;
    }

    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemFinal },
          { role: 'user', content: transcriptionText },
        ],
        tools,
        tool_choice: { type: 'function', function: { name: 'parse_transcription_result' } },
        temperature: 0.1,
        max_tokens: 8000,
      }),
    });

    const responseText = await groqResponse.text();

    if (!groqResponse.ok) {
      let errMsg = 'Error al comunicarse con Groq';
      try { errMsg = JSON.parse(responseText).error?.message || errMsg; } catch { errMsg = responseText || errMsg; }
      return res.status(groqResponse.status).json({ error: errMsg });
    }

    const aiData = JSON.parse(responseText);
    const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];

    if (!toolCall?.function?.arguments) {
      const content = aiData.choices?.[0]?.message?.content || '';
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || content.match(/(\{[\s\S]*\})/);
      if (!jsonMatch)
        return res.status(500).json({ error: 'No se pudo parsear la respuesta de Groq' });
      return res.status(200).json(JSON.parse(jsonMatch[1] || jsonMatch[0]));
    }

    const parsed = JSON.parse(toolCall.function.arguments);

    // Inyectar hallazgos directamente desde el texto transcrito (sin LLM)
    if (parsed.estudios) {
      parsed.estudios = extraerHallazgosDesdeTexto(transcriptionText, parsed.estudios);
    }

    const plantillasDisponibles = modoManual ? [] : (templateNames || []);
    if (plantillasDisponibles.length > 0 && parsed.estudios) {
      parsed.estudios = parsed.estudios.map(estudio => {
        const existeExacta = plantillasDisponibles.find(p => p === estudio.plantilla_match);
        if (existeExacta) return estudio;
        const plantillaCercana = encontrarPlantillaMasCercana(
          estudio.tipo_estudio,
          estudio.region,
          estudio.es_contrastado,
          estudio.conclusiones,
          estudio.hallazgos,
          plantillasDisponibles
        );
        return { ...estudio, plantilla_match: plantillaCercana };
      });
    }

    console.log(`[parse-transcription] ✅ ${parsed.estudios?.length || 0} estudios`);
    return res.status(200).json(parsed);

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[parse-transcription] Error:', msg);
    return res.status(500).json({ error: msg });
  }
};
