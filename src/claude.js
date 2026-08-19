'use strict';

const Anthropic = require('@anthropic-ai/sdk').default;
const { z } = require('zod');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');

const MODELO = process.env.MODELO_CLAUDE || 'claude-opus-5';

// Precios USD por millón de tokens, para estimar el gasto por foto.
const PRECIOS = {
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

// Con SIMULAR_LECTURA=1 no se llama a la API: sirve para probar la app sin gastar.
const SIMULAR = process.env.SIMULAR_LECTURA === '1';
const cliente = SIMULAR ? null : new Anthropic();

const EsquemaBillete = z.object({
  serial: z
    .string()
    .describe(
      'Número de serie completo tal como aparece impreso, incluyendo letras de prefijo y sufijo. Ej: "MB 12345678 A". Si no se lee completo, escribe la parte legible y usa "?" por cada carácter ilegible.'
    ),
  denominacion: z
    .number()
    .int()
    .describe('Denominación en dólares: 1, 2, 5, 10, 20, 50 o 100. Usa 0 si no se distingue.'),
  serie: z
    .string()
    .describe('Año de serie impreso en el billete, ej "2017A". Cadena vacía si no se lee.'),
  letra_distrito: z
    .string()
    .describe('Letra del banco de la Reserva Federal emisor si es visible, ej "B". Cadena vacía si no se lee.'),
  confianza: z
    .enum(['alta', 'media', 'baja'])
    .describe('Qué tan seguro estás de haber leído correctamente el número de serie completo.'),
  observaciones: z
    .string()
    .describe(
      'Notas breves sobre el estado físico o la legibilidad: "billete deteriorado", "reflejo tapa el último dígito", "solo se ve el reverso", etc. Cadena vacía si no hay nada que anotar.'
    ),
});

const EsquemaLectura = z.object({
  billetes: z.array(EsquemaBillete).describe('Un objeto por cada billete visible en la foto.'),
  nota_general: z
    .string()
    .describe('Comentario general sobre la foto (calidad, cuántos billetes se ven, si falta algo). Cadena vacía si no aplica.'),
});

const INSTRUCCIONES = `Eres el asistente de registro de un local que recibe dólares en efectivo.
Tu única tarea es leer los billetes de dólar estadounidense que aparecen en la foto y transcribir sus datos con exactitud.

Reglas:
- Reporta UN objeto por cada billete visible, aunque estén superpuestos o parcialmente tapados.
- El número de serie de un billete de dólar tiene el formato: una o dos letras, ocho dígitos y (en la mayoría de las series) una letra final. Ej: "MB 12345678 A".
- Transcribe EXACTAMENTE lo que ves. Nunca inventes ni completes dígitos que no puedas leer: usa "?" por cada carácter ilegible y marca la confianza como "baja".
- Distingue con cuidado los caracteres parecidos: 0 vs O, 1 vs I, 5 vs S, 8 vs B, 2 vs Z.
- Si un billete aparece por el reverso (sin número de serie visible), repórtalo con serial "" y explica en observaciones.
- Si la foto no contiene billetes de dólar, devuelve la lista vacía y explícalo en nota_general.
- No opines sobre si el billete es auténtico o falso; limítate a describir lo que se ve.`;

/**
 * Lee los billetes de una imagen.
 * @param {Buffer} buffer imagen ya redimensionada
 * @param {string} mediaType 'image/jpeg' | 'image/png' | 'image/webp'
 */
async function leerBilletes(buffer, mediaType = 'image/jpeg') {
  if (SIMULAR) {
    const n = (buffer.length % 9000000) + 1000000;
    return {
      lectura: {
        billetes: [
          {
            serial: `MB ${String(n).padStart(8, '0')} A`,
            denominacion: 20,
            serie: '2017A',
            letra_distrito: 'B',
            confianza: 'alta',
            observaciones: '',
          },
        ],
        nota_general: 'Lectura simulada (SIMULAR_LECTURA=1).',
      },
      modelo: 'simulado',
      tokens_in: 0,
      tokens_out: 0,
      costo_usd: 0,
    };
  }

  const respuesta = await cliente.messages.parse({
    model: MODELO,
    max_tokens: 8000,
    system: INSTRUCCIONES,
    output_config: {
      format: zodOutputFormat(EsquemaLectura),
      effort: 'medium',
    },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') },
          },
          {
            type: 'text',
            text: 'Registra todos los billetes de dólar que veas en esta foto.',
          },
        ],
      },
    ],
  });

  const uso = respuesta.usage || {};
  const precio = PRECIOS[MODELO] || PRECIOS['claude-opus-5'];
  const tokensIn = (uso.input_tokens || 0) + (uso.cache_read_input_tokens || 0);
  const tokensOut = uso.output_tokens || 0;

  return {
    lectura: respuesta.parsed_output || { billetes: [], nota_general: 'No se pudo interpretar la respuesta.' },
    modelo: respuesta.model || MODELO,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    costo_usd: (tokensIn / 1e6) * precio.in + (tokensOut / 1e6) * precio.out,
  };
}

module.exports = { leerBilletes, MODELO };
