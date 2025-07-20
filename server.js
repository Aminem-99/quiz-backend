import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
// Ajout : import jsonrepair
import { jsonrepair } from 'jsonrepair';

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3001;

// Configure middleware
app.use(cors());
app.use(express.json());

// Get current file directory (ESM equivalent of __dirname)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Quiz generation endpoint
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

    console.log("[/api/generate-quiz] Clé API présente :", !!process.env.DEEPSEEK_API_KEY);

    const payload = {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'You are a history expert who creates educational quiz questions.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7
    };
    console.log("[/api/generate-quiz] Payload DeepSeek :", JSON.stringify(payload));

    let response;
    try {
      response = await axios.post(
        'https://api.deepseek.com/v1/chat/completions',
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
          }
        }
      );
      console.log("[/api/generate-quiz] Status code DeepSeek :", response.status);
      console.log("[/api/generate-quiz] Réponse brute DeepSeek :", response.data);
    } catch (apiError) {
      console.error("[/api/generate-quiz] Erreur lors de l'appel à DeepSeek :", apiError.response ? apiError.response.data : apiError.message);
      return res.status(500).json({ 
        error: 'Erreur lors de l\'appel à DeepSeek',
        details: apiError.response ? apiError.response.data : apiError.message
      });
    }

    const content = response.data.choices?.[0]?.message?.content;
    if (!content) {
      console.error("[/api/generate-quiz] Contenu vide ou structure inattendue :", response.data);
      return res.status(500).json({ 
        error: 'Empty or invalid API response',
        details: 'No content found in API response'
      });
    }
    console.log("[/api/generate-quiz] Contenu reçu (brut) :", content);

    let questions;
    // 1e tentative : parsing JSON classique
    try {
      questions = JSON.parse(content);
      console.log("[/api/generate-quiz] Parsing JSON réussi !");
    } catch (parseError) {
      // 2e tentative : jsonrepair
      console.warn("[/api/generate-quiz] Parsing JSON échoué, tentative de réparation avec jsonrepair...");
      try {
        questions = JSON.parse(jsonrepair(content));
        console.log("[/api/generate-quiz] JSON réparé et parsé avec succès !");
      } catch (repairError) {
        // 3e tentative : extraction regex fallback
        console.warn("[/api/generate-quiz] Réparation échouée, tentative d'extraction du JSON du texte...");
        let cleanedContent = content
          .replace(/```json\n?/, '') // Remove opening ```json
          .replace(/\n?```/, '')     // Remove closing ```
          .trim();

        const jsonMatch = cleanedContent.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          try {
            questions = JSON.parse(jsonMatch[0]);
            console.log("[/api/generate-quiz] Extraction JSON réussie !");
          } catch (extractError) {
            console.error("[/api/generate-quiz] Extraction JSON échouée :", extractError);
            return res.status(500).json({ 
              error: 'Failed to parse API response (extraction)',
              details: extractError.message,
              raw: content
            });
          }
        } else {
          console.error("[/api/generate-quiz] Impossible d'extraire du JSON du texte :", cleanedContent);
          return res.status(500).json({ 
            error: 'Failed to parse API response',
            details: repairError.message,
            raw: content
          });
        }
      }
    }

    // Validation de la structure du quiz
    if (!Array.isArray(questions)) {
      console.error("[/api/generate-quiz] La réponse n'est pas un tableau :", questions);
      return res.status(500).json({ 
        error: 'Invalid API response format',
        details: 'Response is not an array'
      });
    }

    if (questions.length !== 5) {
      console.error("[/api/generate-quiz] Nombre incorrect de questions :", questions.length);
      return res.status(500).json({ 
        error: 'Invalid number of questions',
        details: `Expected 5 questions, received ${questions.length}`
      });
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
        console.error("[/api/generate-quiz] Question invalide à l'index", i, ":", q);
        return res.status(500).json({ 
          error: 'Invalid question structure',
          details: `Question at index ${i} is missing required fields or has invalid options`
        });
      }
      for (const ans of q.answer) {
        if (!q.options.includes(ans)) {
          console.error("[/api/generate-quiz] Réponse invalide à l'index", i, ":", ans);
          return res.status(500).json({ 
            error: 'Invalid answer',
            details: `Answer "${ans}" at index ${i} does not match any option`
          });
        }
      }
    }

    console.log("[/api/generate-quiz] Quiz généré avec succès !");
    res.json(questions);

  } catch (error) {
    console.error("[/api/generate-quiz] Erreur inattendue :", error);
    res.status(500).json({ 
      error: 'Failed to generate quiz questions',
      details: error.message
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  console.log("[/api/health] Health check requested");
  res.json({ status: 'ok', message: 'Server is running' });
});

// Handle SIGTERM gracefully
process.on('SIGTERM', () => {
  console.log('Received SIGTERM. Performing graceful shutdown...');
  server.close(() => {
    console.log('Server closed. Exiting process.');
    process.exit(0);
  });
});

// Handle SIGINT (Ctrl+C)
process.on('SIGINT', () => {
  console.log('Received SIGINT. Performing graceful shutdown...');
  server.close(() => {
    console.log('Server closed. Exiting process.');
    process.exit(0);
  });
});

// Start the server
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`API endpoint available at http://localhost:${PORT}/api/generate-quiz`);
});
