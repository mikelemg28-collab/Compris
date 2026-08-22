module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Método no permitido.'
    });
  }

  const url = String(req.body?.url || '').trim().slice(0, 1500);

  if (!url) {
    return res.status(400).json({
      error: 'Pega el enlace de una receta.'
    });
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(url);

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('Protocolo inválido');
    }
  } catch {
    return res.status(400).json({
      error: 'El enlace de la receta no es válido.'
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: 'Falta configurar GEMINI_API_KEY en Vercel.'
    });
  }

  const units = [
    'unidad',
    'g',
    'kg',
    'ml',
    'l',
    'paquete',
    'atado',
    'cucharada',
    'taza',
    'pizca'
  ];

  const categories = [
    'Verdulería',
    'Almacén',
    'Carnicería',
    'Panadería',
    'Lácteos',
    'Fiambrería',
    'Bebidas',
    'Congelados',
    'Otros'
  ];

  const types = [
    'Plato principal',
    'Acompañamiento',
    'Ensalada',
    'Sopa/crema',
    'Pastas',
    'Salsas',
    'Postre',
    'Desayuno/Merienda',
    'Otro'
  ];

  try {

    /* =====================================================
       1. LEER LA PÁGINA DE LA RECETA
    ===================================================== */

    const pageResponse = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36',
        'Accept':
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language':
          'es-419,es;q=0.9,en;q=0.7'
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!pageResponse.ok) {
      console.error(
        'Error al leer página:',
        pageResponse.status,
        url
      );

      return res.status(422).json({
        error:
          'El sitio no permitió leer esa receta. Prueba con otro enlace.'
      });
    }

    const html = await pageResponse.text();

    if (!html || html.length < 100) {
      return res.status(422).json({
        error:
          'No pude obtener información suficiente de esa página.'
      });
    }


    /* =====================================================
       2. BUSCAR DATOS ESTRUCTURADOS DE RECETA
    ===================================================== */

    let recipeData = null;

    const jsonLdRegex =
      /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

    let match;

    while ((match = jsonLdRegex.exec(html)) !== null) {
      try {
        let jsonText = match[1]
          .replace(/&quot;/g, '"')
          .replace(/&#34;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&amp;/g, '&')
          .trim();

        const parsed = JSON.parse(jsonText);

        const candidates = [];

        function collect(value) {
          if (!value) return;

          if (Array.isArray(value)) {
            value.forEach(collect);
            return;
          }

          if (typeof value !== 'object') return;

          candidates.push(value);

          if (Array.isArray(value['@graph'])) {
            value['@graph'].forEach(collect);
          }

          if (value.mainEntity) {
            collect(value.mainEntity);
          }
        }

        collect(parsed);

        const found = candidates.find(item => {
          const type = item?.['@type'];

          if (Array.isArray(type)) {
            return type.some(t =>
              String(t).toLowerCase() === 'recipe'
            );
          }

          return String(type || '').toLowerCase() === 'recipe';
        });

        if (
          found &&
          Array.isArray(found.recipeIngredient) &&
          found.recipeIngredient.length
        ) {
          recipeData = {
            name: found.name || '',
            servings:
              found.recipeYield ||
              found.yield ||
              '',
            ingredients: found.recipeIngredient
          };

          break;
        }

      } catch (e) {
        // Algunos scripts JSON-LD no son JSON válido.
        // Se ignoran y se continúa buscando.
      }
    }


    /* =====================================================
       3. SI NO HAY JSON-LD, EXTRAER TEXTO DE LA PÁGINA
    ===================================================== */

    let pageText = '';

    if (!recipeData) {

      pageText = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 30000);

      if (pageText.length < 200) {
        return res.status(422).json({
          error:
            'No pude leer los ingredientes de esa página. Prueba con otra receta.'
        });
      }
    }


    /* =====================================================
       4. PREPARAR LA INFORMACIÓN PARA GEMINI
    ===================================================== */

    let sourceText;

    if (recipeData) {

      sourceText = `
Nombre publicado:
${recipeData.name || 'No especificado'}

Porciones o rendimiento publicado:
${recipeData.servings || 'No especificado'}

Ingredientes publicados:
${recipeData.ingredients
  .slice(0, 80)
  .map((item, index) => `${index + 1}. ${item}`)
  .join('\n')}
`;

    } else {

      sourceText = `
Contenido obtenido de la página de la receta:

${pageText}
`;

    }


    const prompt = `
Convierte la información de esta receta al formato de la aplicación Compri.

REGLAS IMPORTANTES:

- Usa únicamente la información incluida debajo.
- No busques nada en Internet.
- No inventes ingredientes.
- No inventes cantidades.
- No incluyas instrucciones de preparación.
- Necesito el nombre de la receta.
- Necesito cuántas porciones rinde.
- Necesito los ingredientes con cantidad y unidad.
- Convierte fracciones a números decimales.
- Si una cantidad dice "1/2", devuelve 0.5.
- Si una cantidad dice "1 1/2", devuelve 1.5.
- Si la receta expresa claramente el rendimiento, respétalo.
- Si no aparece ningún rendimiento, usa 4 porciones.

Las únicas unidades permitidas son:

${units.join(', ')}

Las únicas categorías permitidas son:

${categories.join(', ')}

Los únicos tipos de receta permitidos son:

${types.join(', ')}

INFORMACIÓN DE LA RECETA:

${sourceText}
`;


    /* =====================================================
       5. ESQUEMA QUE NECESITA COMPRI
    ===================================================== */

    const schema = {
      type: 'OBJECT',

      properties: {

        name: {
          type: 'STRING'
        },

        servings: {
          type: 'INTEGER'
        },

        type: {
          type: 'STRING',
          enum: types
        },

        ingredients: {
          type: 'ARRAY',

          items: {
            type: 'OBJECT',

            properties: {

              name: {
                type: 'STRING'
              },

              qty: {
                type: 'NUMBER'
              },

              unit: {
                type: 'STRING',
                enum: units
              },

              category: {
                type: 'STRING',
                enum: categories
              }

            },

            required: [
              'name',
              'qty',
              'unit',
              'category'
            ]
          }
        }
      },

      required: [
        'name',
        'servings',
        'type',
        'ingredients'
      ]
    };


    /* =====================================================
       6. GEMINI SOLO INTERPRETA
       NO USA GOOGLE SEARCH
    ===================================================== */

    const geminiResponse = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
      {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },

        body: JSON.stringify({

          contents: [
            {
              parts: [
                {
                  text: prompt
                }
              ]
            }
          ],

          generationConfig: {
            response_mime_type: 'application/json',
            response_schema: schema,
            temperature: 0.1
          }

        })
      }
    );


    /* =====================================================
       7. LEER RESPUESTA DE GEMINI
    ===================================================== */

    const raw = await geminiResponse.json();

    if (!geminiResponse.ok) {

      console.error(
        'Gemini error:',
        JSON.stringify(raw)
      );

      if (geminiResponse.status === 429) {
        return res.status(429).json({
          error:
            'Gemini alcanzó temporalmente el límite gratuito. Intenta nuevamente más tarde.'
        });
      }

      return res.status(geminiResponse.status).json({
        error:
          'Gemini no pudo procesar los ingredientes de esta receta.'
      });
    }


    const text =
      raw?.candidates?.[0]?.content?.parts
        ?.map(part => part.text || '')
        .join('')
        .trim() || '';


    if (!text) {
      return res.status(502).json({
        error:
          'Gemini no devolvió información de la receta.'
      });
    }


    let recipe;

    try {
      recipe = JSON.parse(text);
    } catch (e) {

      console.error(
        'JSON de Gemini inválido:',
        text.slice(0, 1000)
      );

      return res.status(502).json({
        error:
          'Gemini devolvió la receta en un formato incorrecto.'
      });
    }


    /* =====================================================
       8. NORMALIZAR PARA COMPRI
    ===================================================== */

    recipe.url = url;

    recipe.name =
      String(recipe.name || recipeData?.name || 'Receta')
        .trim();

    recipe.servings =
      Math.max(
        1,
        parseInt(recipe.servings, 10) || 4
      );

    recipe.type =
      types.includes(recipe.type)
        ? recipe.type
        : 'Otro';

    recipe.ingredients =
      (recipe.ingredients || [])
        .filter(item =>
          item &&
          item.name &&
          Number(item.qty) > 0
        )
        .map(item => ({

          name:
            String(item.name).trim(),

          qty:
            Number(item.qty),

          unit:
            units.includes(item.unit)
              ? item.unit
              : 'unidad',

          category:
            categories.includes(item.category)
              ? item.category
              : 'Otros'

        }));


    if (!recipe.ingredients.length) {
      return res.status(422).json({
        error:
          'No pude identificar ingredientes con cantidades en esta receta.'
      });
    }


    /* =====================================================
       9. RESPUESTA FINAL A COMPRI
    ===================================================== */

    return res.status(200).json(recipe);


  } catch (err) {

    console.error(
      'Error recipe-search:',
      err?.message || err
    );

    if (err?.name === 'TimeoutError') {
      return res.status(504).json({
        error:
          'La página de la receta tardó demasiado en responder. Prueba con otro enlace.'
      });
    }

    return res.status(500).json({
      error:
        'Ocurrió un error al procesar la receta.'
    });
  }
};
