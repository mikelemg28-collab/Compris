module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido.' });
  }

  const query = String(req.body?.query || '').trim().slice(0, 120);

  if (!query) {
    return res.status(400).json({
      error: 'Escribí qué receta querés buscar.'
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
       1. BUSCAR RECETAS EN INTERNET
       ===================================================== */

    const searchUrl =
      'https://html.duckduckgo.com/html/?q=' +
      encodeURIComponent(query + ' receta ingredientes');

    const searchResponse = await fetch(searchUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!searchResponse.ok) {
      console.error('Error buscador:', searchResponse.status);

      return res.status(502).json({
        error: 'No pude buscar recetas en internet.'
      });
    }

    const searchHtml = await searchResponse.text();

    /* =====================================================
       2. EXTRAER LINKS DE LOS RESULTADOS
       ===================================================== */

    const links = [];

    const resultRegex =
      /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"/gi;

    let match;

    while ((match = resultRegex.exec(searchHtml)) !== null) {
      let url = match[1];

      try {
        const parsed = new URL(url, 'https://duckduckgo.com');

        const redirectedUrl = parsed.searchParams.get('uddg');

        if (redirectedUrl) {
          url = decodeURIComponent(redirectedUrl);
        }

        if (
          url.startsWith('http') &&
          !url.includes('duckduckgo.com')
        ) {
          links.push(url);
        }
      } catch (e) {}
    }

    const uniqueLinks = [...new Set(links)].slice(0, 6);

    if (!uniqueLinks.length) {
      return res.status(404).json({
        error: 'No encontré recetas para esa búsqueda.'
      });
    }

    /* =====================================================
       3. BUSCAR UNA PÁGINA CON DATOS DE RECETA
       ===================================================== */

    let recipeSource = null;

    for (const url of uniqueLinks) {
      try {
        const pageResponse = await fetch(url, {
          redirect: 'follow',
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          signal: AbortSignal.timeout(7000)
        });

        if (!pageResponse.ok) continue;

        const html = await pageResponse.text();

        const jsonLdRegex =
          /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

        let jsonMatch;

        while ((jsonMatch = jsonLdRegex.exec(html)) !== null) {
          try {
            const parsed = JSON.parse(
              jsonMatch[1]
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .trim()
            );

            const candidates = [];

            if (Array.isArray(parsed)) {
              candidates.push(...parsed);
            } else {
              candidates.push(parsed);

              if (Array.isArray(parsed['@graph'])) {
                candidates.push(...parsed['@graph']);
              }
            }

            const recipe = candidates.find(item => {
              if (!item) return false;

              const type = item['@type'];

              if (Array.isArray(type)) {
                return type.includes('Recipe');
              }

              return type === 'Recipe';
            });

            if (
              recipe &&
              Array.isArray(recipe.recipeIngredient) &&
              recipe.recipeIngredient.length
            ) {
              recipeSource = {
                url,
                name: recipe.name || query,
                servings:
                  recipe.recipeYield ||
                  recipe.yield ||
                  '',
                ingredients:
                  recipe.recipeIngredient
              };

              break;
            }
          } catch (e) {}
        }

        if (recipeSource) break;

      } catch (e) {
        console.log('No se pudo leer:', url);
      }
    }

    if (!recipeSource) {
      return res.status(404).json({
        error:
          'Encontré resultados, pero no pude leer los ingredientes de ninguna receta. Probá otra búsqueda.'
      });
    }

    /* =====================================================
       4. GEMINI SOLO INTERPRETA LOS INGREDIENTES
       NO BUSCA EN GOOGLE
       ===================================================== */

    const ingredientText =
      recipeSource.ingredients
        .slice(0, 60)
        .map((i, index) => `${index + 1}. ${i}`)
        .join('\n');

    const prompt = `
Convertí la siguiente receta al formato de la aplicación Compri.

IMPORTANTE:
- NO busques nada en internet.
- Usá exclusivamente la información que te proporciono.
- No inventes ingredientes.
- No inventes cantidades.
- No incluyas instrucciones de preparación.
- Necesito únicamente nombre, porciones e ingredientes.
- Las cantidades deben ser numéricas.
- Convertí fracciones a decimales.
- Normalizá las unidades exclusivamente a:
${units.join(', ')}.
- Clasificá cada ingrediente exclusivamente en:
${categories.join(', ')}.
- Clasificá la receta exclusivamente como:
${types.join(', ')}.

RECETA:
Nombre: ${recipeSource.name}

Rendimiento indicado por la página:
${recipeSource.servings || 'No especificado'}

INGREDIENTES:
${ingredientText}
`;

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
       5. CONSULTAR GEMINI FLASH-LITE
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

    const raw = await geminiResponse.json();

    if (!geminiResponse.ok) {
      console.error('Gemini error:', raw);

      return res.status(geminiResponse.status).json({
        error: 'Gemini no pudo procesar la receta encontrada.'
      });
    }

    const text =
      raw?.candidates?.[0]?.content?.parts
        ?.map(p => p.text || '')
        .join('') || '';

    if (!text) {
      return res.status(502).json({
        error: 'Gemini no devolvió los ingredientes.'
      });
    }

    const recipe = JSON.parse(text);

    /* =====================================================
       6. NORMALIZAR PARA COMPRI
       ===================================================== */

    recipe.url = recipeSource.url;

    recipe.servings =
      Math.max(
        1,
        parseInt(recipe.servings, 10) || 4
      );

    recipe.ingredients =
      (recipe.ingredients || [])

        .filter(
          i =>
            i?.name &&
            Number(i.qty) > 0
        )

        .map(i => ({

          name:
            String(i.name).trim(),

          qty:
            Number(i.qty),

          unit:
            units.includes(i.unit)
              ? i.unit
              : 'unidad',

          category:
            categories.includes(i.category)
              ? i.category
              : 'Otros'

        }));

    if (!recipe.ingredients.length) {
      return res.status(502).json({
        error:
          'No pude interpretar cantidades válidas para esta receta.'
      });
    }

    /* =====================================================
       7. DEVOLVER RECETA A COMPRI
       ===================================================== */

    return res.status(200).json(recipe);

  } catch (err) {

    console.error('Recipe search error:', err);

    return res.status(500).json({
      error:
        'Ocurrió un error al buscar la receta.'
    });

  }
};
