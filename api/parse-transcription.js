module.exports.config = {
  api: { bodyParser: { sizeLimit: '2mb' } },
};

const systemPromptManual = `Parser de transcripciones radiológicas. Extrae TODOS los estudios via tool call.

Campos por estudio:
- nombre_paciente, tipo_estudio(TAC o RM), region, lateralidad("derecha"/"izquierda"/"bilateral" o null), es_contrastado(true/false)
- datos_clinicos: indicación/diagnóstico, o ""
- conclusiones: conclusiones/impresión diagnóstica, o ""
- hallazgos: ""
- plantilla_match: null
- nombre_archivo_sugerido: nombre_paciente + tipo_estudio + region + lateralidad

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
- nombre_archivo_sugerido: nombre_paciente + tipo_estudio + region + lateralidad

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
    { cuando: esRM && reg.includes('hombro') && (textoCompleto.includes('ruptura parcial') || textoCompleto.includes('rotura parcial')), buscar: ['hombro', 'parcial'] },
    { cuando: esRM && reg.includes('hombro') && (textoCompleto.includes('ruptura completa') || textoCompleto.includes('rotura completa')), buscar: ['hombro', 'completa'] },
    { cuando: esRM && reg.includes('hombro'), buscar: ['hombro', 'tendinosis'] },
    { cuando: esRM && reg.includes('rodilla') && (textoCompleto.includes('ruptura') || textoCompleto.includes('rotura') || textoCompleto.includes('desgarro')), buscar: ['rodilla', 'lesion'] },
    { cuando: esRM && reg.includes('rodilla'), buscar: ['rodilla'] },
    { cuando: esRM && (reg.includes('columna lumbar') || reg.includes('lumbar')), buscar: ['lumbar'] },
    { cuando: esRM && (reg.includes('columna cervical') || reg.includes('cervical')), buscar: ['cervical'] },
    { cuando: esRM && (reg.includes('columna dorsal') || reg.includes('dorsal')), buscar: ['dorsal'] },
    { cuando: esRM && (reg.includes('cerebro') || reg.includes('craneo') || reg.includes('cráneo') || reg.includes('encefalo')), buscar: ['cerebro'] },
    { cuando: esRM && reg.includes('abdomen'), buscar: ['abdomen'] },
    { cuando: esTAC && reg.includes('abdomen') && !textoCompleto.includes('simple'), buscar: ['abdomen', 'contrastado'] },
    { cuando: esTAC && reg.includes('abdomen') && textoCompleto.includes('simple'), buscar: ['abdomen'] },
    { cuando: esTAC && (reg.includes('torax') || reg.includes('tórax')) && !textoCompleto.includes('simple'), buscar: ['torax', 'contrastado'] },
    { cuando: esTAC && (reg.includes('torax') || reg.includes('tórax')) && textoCompleto.includes('simple'), buscar: ['torax'] },
    { cuando: esTAC && (reg.includes('toracoabdominal') || (reg.includes('torax') && reg.includes('abdomen'))), buscar: ['toracoabdominal', 'contrastado'] },
    { cuando: esTAC && (reg.includes('hombro') || reg.includes('tobillo') || reg.includes('rodilla') || reg.includes('pie') || reg.includes('mano') || reg.includes('muneca') || reg.includes('muñeca') || reg.includes('cadera') || reg.includes('codo')), buscar: ['musculoesqueletico'] },
    { cuando: esTAC && (reg.includes('craneo') || reg.includes('cráneo') || reg.includes('cerebro') || reg.includes('encefalo')), buscar: ['craneo'] },
    { cuando: esTAC && reg.includes('lumbar'), buscar: ['lumbar'] },
    { cuando: esTAC && reg.includes('cervical'), buscar: ['cervical'] },
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
            },
            required: ['nombre_paciente','tipo_estudio','region','lateralidad','es_contrastado','hallazgos','conclusiones','datos_clinicos','plantilla_match','nombre_archivo_sugerido'],
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

// Divide el texto en bloques por estudio.
// Reglas de corte (en orden de prioridad):
// 1. "siguiente paciente" precedido de conclusión
// 2. "el mismo" / "el siguiente" precedido de conclusión  
// 3. Doble salto de línea + nombre propio (2+ palabras capitalizadas)
function dividirPorEstudios(texto, numEstudios) {
  if (numEstudios <= 1) return [texto];

  const textoLower = texto.toLowerCase();
  const splits = [];

  // Buscar indicadores de nuevo estudio: "siguiente paciente", "el mismo", "el siguiente paciente"
  const patronesNuevoEstudio = [
    'siguiente paciente',
    'el mismo tiene',
    'el mismo paciente',
    'el siguiente paciente',
  ];

  for (const patron of patronesNuevoEstudio) {
    let pos = 0;
    while (true) {
      const idx = textoLower.indexOf(patron, pos);
      if (idx === -1) break;
      // Verificar que haya una conclusión en algún lugar antes
      const antes = textoLower.substring(0, idx);
      if (antes.includes('conclusi') || antes.includes('impresi')) {
        splits.push(idx);
      }
      pos = idx + 1;
    }
  }

  // También buscar doble salto de línea seguido de nombre propio (mayúscula + apellidos)
  // Solo si hay conclusión antes en el texto
  const doblesSaltos = [];
  let pos = 0;
  while (true) {
    const idx = texto.indexOf('\n\n', pos);
    if (idx === -1) break;
    const despues = texto.substring(idx + 2, idx + 100).trim();
    const palabras = despues.split(/\s+/).slice(0, 4);
    const conMayuscula = palabras.filter(p => p.length > 1 && p[0] === p[0].toUpperCase() && p[0] !== p[0].toLowerCase());
    if (conMayuscula.length >= 2) {
      const antes = textoLower.substring(0, idx);
      if (antes.includes('conclusi') || antes.includes('impresi')) {
        doblesSaltos.push(idx + 2);
      }
    }
    pos = idx + 1;
  }

  // Combinar y ordenar splits
  const todosLosSplits = [...new Set([...splits, ...doblesSaltos])].sort((a, b) => a - b);

  if (todosLosSplits.length === 0) return Array(numEstudios).fill(texto);

  // Generar bloques
  const bloques = [];
  let inicio = 0;

  for (let i = 0; i < todosLosSplits.length && bloques.length < numEstudios - 1; i++) {
    const bloque = texto.substring(inicio, todosLosSplits[i]).trim();
    if (bloque.length > 20) {
      bloques.push(bloque);
      inicio = todosLosSplits[i];
    }
  }

  bloques.push(texto.substring(inicio).trim());

  if (bloques.length < numEstudios) return Array(numEstudios).fill(texto);

  return bloques;
}

function extraerHallazgosDesdeTexto(transcriptionText, estudios) {
  if (!estudios || estudios.length === 0) return estudios;

  const bloques = dividirPorEstudios(transcriptionText, estudios.length);

  return estudios.map((estudio, i) => {
    let fragmento = bloques[i] || transcriptionText;

    // Quitar conclusiones del final
    const conclusionRegex = /[*]{0,2}(conclusi[oó]n|conclusiones|impresi[oó]n diagn[oó]stica)[^]*/i;
    const match = fragmento.match(conclusionRegex);
    if (match && match.index > fragmento.length * 0.4) {
      fragmento = fragmento.substring(0, match.index).trim();
    }

    // Quitar datos clínicos del inicio
    const datosKeywords = ['datos clínicos', 'datos clinicos', 'indicación', 'indicacion'];
    for (const kw of datosKeywords) {
      const idx = fragmento.toLowerCase().indexOf(kw);
      if (idx !== -1 && idx < 150) {
        const newline = fragmento.indexOf('\n', idx);
        if (newline !== -1) fragmento = fragmento.substring(newline + 1).trim();
        break;
      }
    }

    // Limpiar separador --- AUDIO --- si quedó al inicio
    if (fragmento.startsWith('---')) {
      const newline = fragmento.indexOf('\n');
      if (newline !== -1) fragmento = fragmento.substring(newline + 1).trim();
    }

    return { ...estudio, hallazgos: fragmento || transcriptionText };
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
        max_tokens: 4000,
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
