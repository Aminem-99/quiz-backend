import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Tentative d'importation de jsonrepair (gestion de l'absence du module)
let jsonrepair = undefined;
try {
  // Dynamically import for ESM support
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  jsonrepair = (await import('jsonrepair')).jsonrepair;
  console.log('[INIT] Module jsonrepair chargé avec succès !');
} catch (e) {
  console.warn('[INIT] Module jsonrepair non trouvé. Le backend fonctionnera mais sera moins robuste au JSON mal formé. Installez-le avec : npm install jsonrepair');
}

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

app.post('/api/generate-quiz', async (req, res) => {
  try {
    console.log("[/api/generate-quiz] Paramètres reçus :", req.body);

    const { difficulty, category, period, episode, moment, geographical_sphere, entity } = req.body;
    if (!difficulty || !category || !period || !geographical_sphere || !entity) {
      console.error("[/api/generate-quiz] Paramètres principaux manquants !");
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    let contextString = `pendant la période historique ${period}`;
    if (episode && episode.trim().length > 0) {
      contextString += `, épisode "${episode}"`;
    }
    if (moment && moment.trim().length > 0) {
      contextString += ` (moment : ${moment})`;
    }

    const prompt = `Génère exactement 5 questions d'histoire sur ${category} concernant la zone géographique ${geographical_sphere} et plus précisément sur ${entity} ${contextString}.
- Chaque question doit avoir exactement 4 propositions de réponse distinctes.
- Selon la difficulté : 
   - easy : toutes les questions n'ont qu'1 seule bonne réponse ("multi": false, "answer": ["Option A"])
   - medium : 1 question peut avoir plus d'une bonne réponse ("multi": true, et "answer": tableau de plusieurs options)
   - hard : plusieurs questions doivent avoir 2, 3 ou même 4 bonnes réponses ("multi": true, et "answer": tableau de plusieurs options)
- Pour chaque question indique la/les bonne(s) réponse(s) dans le champ "answer" (toujours un tableau, même pour une seule bonne réponse).
- Ajoute aussi un champ "multi" (boolean) pour indiquer si c'est une question à choix multiple ou non.
- Retourne strictement le JSON suivant (pas de markdown, pas d'explications hors du JSON) :
[
  {
    "question": "Texte de la question",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "answer": ["Option correcte", "Option correcte 2"], // tableau, même pour 1 bonne réponse
    "multi": true,
    "explanation": "Explication de la/les bonne(s) réponse(s)."
  }
]
La difficulté des questions est ${difficulty}.`;

    console.log("[/api/generate-quiz] Prompt envoyé :", prompt);

    const payload = {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'You are a history expert who creates educational quiz questions.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      stream: true // Enable streaming
    };
    console.log("[/api/generate-quiz] Payload DeepSeek :", JSON.stringify(payload));

    // Set headers for Server-Sent Events
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let response;
    try {
      response = await axios.post(
        'https://api.deepseek.com/v1/chat/completions',
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
          },
          responseType: 'stream' // Set Axios to handle streaming response
        }
      );
      console.log("[/api/generate-quiz] Streaming started from DeepSeek");
    } catch (apiError) {
      console.error("[/api/generate-quiz] Erreur lors de l'appel à DeepSeek :", apiError.response ? apiError.response.data : apiError.message);
      res.write('event: error\ndata: ' + JSON.stringify({ 
        error: 'Erreur lors de l\'appel à DeepSeek',
        details: apiError.response ? apiError.response.data : apiError.message
      }) + '\n\n');
      res.end();
      return;
    }

    // Accumulate stream data
    let accumulatedData = '';

    response.data.on('data', (chunk) => {
      const chunkStr = chunk.toString();
      console.log("[/api/generate-quiz] Chunk reçu :", chunkStr);

      // Send chunk to client
      res.write(`data: ${chunkStr}\n\n`);

      // Accumulate chunks for final parsing
      accumulatedData += chunkStr;
    });

    response.data.on('end', () => {
      console.log("[/api/generate-quiz] Stream terminé");

      // Attempt to parse accumulated data
      let questions;
      try {
        // DeepSeek stream sends data in SSE format, parse the accumulated JSON
        const lines = accumulatedData.split('\n');
        let jsonContent = '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            jsonContent += line.replace('data: ', '');
          }
        }

        try {
          questions = JSON.parse(jsonContent);
          console.log("[/api/generate-quiz] Parsing JSON réussi !");
        } catch (parseError) {
          if (jsonrepair) {
            try {
              console.warn("[/api/generate-quiz] Parsing JSON échoué, tentative de réparation avec jsonrepair...");
              questions = JSON.parse(jsonrepair(jsonContent));
              console.log("[/api/generate-quiz] JSON réparé et parsé avec succès !");
            } catch (repairError) {
              console.warn("[/api/generate-quiz] Réparation échouée, tentative d'extraction du JSON...");
              let cleanedContent = jsonContent.replace(/```json\n?/, '').replace(/\n?```/, '').trim();
              const jsonMatch = cleanedContent.match(/\[[\s\S]*\]/);
              if (jsonMatch) {
                questions = JSON.parse(jsonMatch[0]);
                console.log("[/api/generate-quiz] Extraction JSON réussie !");
              } else {
                throw new Error('No valid JSON found');
              }
            }
          } else {
            console.warn("[/api/generate-quiz] Parsing JSON échoué et jsonrepair non disponible...");
            let cleanedContent = jsonContent.replace(/```json\n?/, '').replace(/\n?```/, '').trim();
            const jsonMatch = cleanedContent.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
              questions = JSON.parse(jsonMatch[0]);
              console.log("[/api/generate-quiz] Extraction JSON réussie !");
            } else {
              throw new Error('No valid JSON found');
            }
          }
        }

        // Validate quiz structure
        if (!Array.isArray(questions)) {
          throw new Error('Response is not an array');
        }
        if (questions.length !== 5) {
          throw new Error(`Expected 5 questions, received ${questions.length}`);
        }
        for (let i = 0; i < questions.length; i++) {
          const q = questions[i];
          if (
            !q.question ||
            !Array.isArray(q.options) ||
            q.options.length !== 4 ||
            !Array.isArray(q.answer) ||
            q.answer.length < 1 ||
            typeof q.multi !== 'boolean' ||
            !q.explanation
          ) {
            throw new Error(`Question at index ${i} is missing required fields or has invalid options`);
          }
          for (const ans of q.answer) {
            if (!q.options.includes(ans)) {
              throw new Error(`Answer "${ans}" at index ${i} does not match any option`);
            }
          }
        }

        console.log("[/api/generate-quiz] Quiz validé avec succès !");
        res.write('event: complete\ndata: ' + JSON.stringify(questions) + '\n\n');
      } catch (error) {
        console.error("[/api/generate-quiz] Erreur lors du traitement final :", error.message);
        res.write('event: error\ndata: ' + JSON.stringify({ 
          error: 'Failed to process stream',
          details: error.message,
          raw: accumulatedData
        }) + '\n\n');
      }
      res.end();
    });

    response.data.on('error', (error) => {
      console.error("[/api/generate-quiz] Erreur dans le stream :", error);
      res.write('event: error\ndata: ' + JSON.stringify({ 
        error: 'Stream error',
        details: error.message
      }) + '\n\n');
      res.end();
    });

    // Handle client disconnect
    req.on('close', () => {
      console.log("[/api/generate-quiz] Client disconnected");
      response.data.destroy();
      res.end();
    });

  } catch (error) {
    console.error("[/api/generate-quiz] Erreur inattendue :", error);
    res.write('event: error\ndata: ' + JSON.stringify({ 
      error: 'Failed to generate quiz questions',
      details: error.message
    }) + '\n\n');
    res.end();
  }
});

app.get('/api/health', (req, res) => {
  console.log("[/api/health] Health check requested");
  res.json({ status: 'ok', message: 'Server is running' });
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM. Performing graceful shutdown...');
  server.close(() => {
    console.log('Server closed. Exiting process.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('Received SIGINT. Performing graceful shutdown...');
  server.close(() => {
    console.log('Server closed. Exiting process.');
    process.exit(0);
  });
});

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`API endpoint available at http://localhost:${PORT}/api/generate-quiz`);
});
