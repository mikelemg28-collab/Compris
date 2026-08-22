module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido.' });
  }

  const url = String(req.body?.url || '').trim().slice(0, 1500);
  if (!url) {
    return res.status(400).json({ error: 'Pega el enlace de la receta.' });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('invalid protocol');
  } catch {
    return res.status(400).json({ error: 'El enlace no parece válido.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Falta configurar GEMINI_API_KEY en Vercel.' });
  }

  const units = ['unidad','g','kg','ml','l','paquete','atado','cucharada','taza','pizca'];
  const categories = ['Verdulería','Almacén','Carnicería','Panadería','Lácteos','Fiambrería','Bebidas','Congelados','Otros'];
  const types = ['Plato principal','Acompañamiento','Ensalada','Sopa/crema','Pastas','Salsas','Postre','Desayuno/Merienda','Otro'];

  function decodeEntities(text = '') {
    return String(text)
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
  }

  function findRecipeNode(value) {
    if (!value) return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findRecipeNode(item);
        if (found) return found;
      }
      return null;
    }
    if (typeof value !== 'object') return null;

    const type = value['@type'];
    const isRecipe = type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'));
    if (isRecipe && Array.isArray(value.recipeIngredient) && value.recipeIngredient.length) {
      return value;
    }

    for (const key of ['@graph', 'mainEntity', 'itemListElement']) {
      if (value[key]) {
        const found = findRecipeNode(value[key]);
        if (found) return found;
      }
    }
    return null;
  }

  function extractJsonLdRecipe(html) {
    const matches = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
    for (const match of matches) {
      const raw = decodeEntities(match[1]).trim();
      if (!raw) continue;
      const candidates = [
        raw,
        raw.replace(/^\s*<!--|-->\s*$/g, '').trim(),
        raw.replace(/[\u0000-\u001F]+/g, ' ').trim()
      ];
      for (const candidate of candidates) {
        try {
          const parsed = JSON.parse(candidate);
          const recipe = findRecipeNode(parsed);
          if (recipe) return recipe;
        } catch (_) {}
      }
    }
    return null;
  }

  function htmlToText(html) {
    return decodeEntities(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  try {
    const pageResponse = await fetch(parsedUrl.toString(), {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-419,es;q=0.9,en;q=0.7'
      },
      signal: AbortSignal.timeout(12000)
    });

    if (!pageResponse.ok) {
      console.error('Recipe page error:', pageResponse.status, parsedUrl.hostname);
      return res.status(422).json({
        error: `Ese sitio no permitió leer la receta (código ${pageResponse.status}). Prueba con otro enlace.`
      });
    }

    const contentType = pageResponse.headers.get('content-type') || '';
    const html = await pageResponse.text();
    if (!html || html.length < 200) {
      return res.status(422).json({ error: 'No se pudo leer suficiente contenido de ese enlace.' });
    }

    const structuredRecipe = extractJsonLdRecipe(html);
    let sourceData = '';

    if (structuredRecipe) {
      const recipeYield = Array.isArray(structuredRecipe.recipeYield)
        ? structuredRecipe.recipeYield.join(', ')
        : (structuredRecipe.recipeYield || '');
      sourceData = [
        'DATOS ESTRUCTURADOS DE LA RECETA:',
        `Nombre: ${structuredRecipe.name || ''}`,
        `Rinde: ${recipeYield}`,
        'Ingredientes:',
        ...(structuredRecipe.recipeIngredient || []).slice(0, 80)
      ].join('\n');
    } else {
      const visibleText = htmlToText(html).slice(0, 45000);
      if (visibleText.length < 300) {
        return res.status(422).json({
          error: 'La página se abrió, pero no se pudo detectar el contenido de la receta. Prueba con otro enlace.'
        });
      }
      sourceData = `TEXTO EXTRAÍDO DE LA PÁGINA:\n${visibleText}`;
    }

    const prompt = `Convierte la siguiente receta al formato de Compri.

REGLAS:
- Usa exclusivamente los datos que aparecen abajo. No busques en internet.
- No inventes ingredientes ni cantidades.
- No incluyas pasos de preparación.
- Devuelve nombre, porciones e ingredientes con cantidades.
- Convierte fracciones a números decimales.
- Si el rendimiento indica "4 porciones", "4 personas", "4 servings" o equivalente, devuelve servings = 4.
- Si no hay rendimiento identificable, devuelve servings = 4 para que la persona pueda corregirlo antes de guardar.
- Normaliza las unidades exclusivamente a: ${units.join(', ')}.
- Clasifica cada ingrediente exclusivamente en: ${categories.join(', ')}.
- Clasifica la receta exclusivamente como: ${types.join(', ')}.
- Si un ingrediente aparece como "a gusto", "cantidad necesaria" o similar sin una cantidad numérica, omítelo.
- Conserva todos los ingredientes que sí tengan una cantidad clara.

${sourceData}`;

    const schema = {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING' },
        servings: { type: 'INTEGER' },
        type: { type: 'STRING', enum: types },
        ingredients: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              name: { type: 'STRING' },
              qty: { type: 'NUMBER' },
              unit: { type: 'STRING', enum: units },
              category: { type: 'STRING', enum: categories }
            },
            required: ['name', 'qty', 'unit', 'category']
          }
        }
      },
      required: ['name', 'servings', 'type', 'ingredients']
    };

    const geminiResponse = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            response_mime_type: 'application/json',
            response_schema: schema,
            temperature: 0.1
          }
        })
      }
    );

    const rawText = await geminiResponse.text();
    let raw;
    try {
      raw = JSON.parse(rawText);
    } catch (_) {
      console.error('Gemini non-JSON response:', geminiResponse.status, rawText.slice(0, 500));
      return res.status(502).json({ error: 'Gemini devolvió una respuesta que Compri no pudo interpretar.' });
    }

    if (!geminiResponse.ok) {
      console.error('Gemini error:', raw);
      if (geminiResponse.status === 429) {
        return res.status(429).json({ error: 'Gemini alcanzó el límite gratuito por ahora. Intenta nuevamente más tarde.' });
      }
      return res.status(geminiResponse.status).json({ error: 'Gemini no pudo interpretar esta receta.' });
    }

    const text = raw?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    if (!text) {
      return res.status(502).json({ error: 'Gemini no devolvió los ingredientes.' });
    }

    let recipe;
    try {
      recipe = JSON.parse(text);
    } catch (_) {
      console.error('Recipe JSON parse error:', text.slice(0, 800));
      return res.status(502).json({ error: 'La receta fue encontrada, pero no se pudo convertir al formato de Compri.' });
    }

    recipe.url = parsedUrl.toString();
    recipe.servings = Math.max(1, parseInt(recipe.servings, 10) || 4);
    recipe.type = types.includes(recipe.type) ? recipe.type : 'Otro';
    recipe.ingredients = (recipe.ingredients || [])
      .filter(i => i?.name && Number(i.qty) > 0)
      .map(i => ({
        name: String(i.name).trim(),
        qty: Number(i.qty),
        unit: units.includes(i.unit) ? i.unit : 'unidad',
        category: categories.includes(i.category) ? i.category : 'Otros'
      }));

    if (!recipe.ingredients.length) {
      return res.status(422).json({
        error: 'No se detectaron ingredientes con cantidades claras en esa receta. Prueba con otro enlace.'
      });
    }

    return res.status(200).json(recipe);
  } catch (err) {
    console.error('Recipe URL error:', err);
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return res.status(504).json({ error: 'La página tardó demasiado en responder. Prueba con otro enlace.' });
    }
    return res.status(500).json({ error: 'Ocurrió un error al leer la receta.' });
  }
};
