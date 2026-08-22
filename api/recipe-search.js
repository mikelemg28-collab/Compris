module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido.' });

  const query = String(req.body?.query || '').trim().slice(0, 120);
  if (!query) return res.status(400).json({ error: 'Escribí qué receta querés buscar.' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Falta configurar GEMINI_API_KEY en Vercel.' });

  const units = ['unidad','g','kg','ml','l','paquete','atado','cucharada','taza','pizca'];
  const categories = ['Verdulería','Almacén','Carnicería','Panadería','Lácteos','Fiambrería','Bebidas','Congelados','Otros'];
  const types = ['Plato principal','Acompañamiento','Ensalada','Sopa/crema','Pastas','Salsas','Postre','Desayuno/Merienda','Otro'];

  const prompt = `Busca en internet una receta real y completa para: "${query}".
Devuelve UNA receta adecuada para un recetario doméstico.
Necesito solamente los datos que Compri usa para calcular la compra: nombre, porciones que rinde e ingredientes con cantidad y unidad.
No incluyas pasos de preparación.
No inventes cantidades si la fuente no las indica: elige otra receta que sí tenga cantidades claras.
Normaliza cada unidad exclusivamente a una de estas: ${units.join(', ')}.
Clasifica cada ingrediente exclusivamente en una de estas categorías: ${categories.join(', ')}.
Clasifica la receta exclusivamente como uno de estos tipos: ${types.join(', ')}.
Las cantidades deben ser números. Convierte fracciones a decimales cuando sea necesario.`;

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
          required: ['name','qty','unit','category']
        }
      }
    },
    required: ['name','servings','type','ingredients']
  };

  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: {
          response_mime_type: 'application/json',
          response_schema: schema,
          temperature: 0.2
        }
      })
    });

    const raw = await response.json();
    if (!response.ok) {
      console.error('Gemini error:', raw);
      return res.status(response.status).json({ error: 'Gemini no pudo completar la búsqueda.' });
    }

    const text = raw?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    if (!text) return res.status(502).json({ error: 'Gemini no devolvió una receta.' });
    const recipe = JSON.parse(text);

    const chunks = raw?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    const source = chunks.find(c => c?.web?.uri);
    recipe.url = source?.web?.uri || '';

    recipe.servings = Math.max(1, parseInt(recipe.servings, 10) || 4);
    recipe.ingredients = (recipe.ingredients || []).filter(i => i?.name && Number(i.qty) > 0).map(i => ({
      name: String(i.name).trim(),
      qty: Number(i.qty),
      unit: units.includes(i.unit) ? i.unit : 'unidad',
      category: categories.includes(i.category) ? i.category : 'Otros'
    }));

    return res.status(200).json(recipe);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Ocurrió un error al buscar la receta.' });
  }
};
