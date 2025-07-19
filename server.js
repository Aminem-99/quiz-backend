import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

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
    // LOG 1 : Paramètres reçus
    console.log("[/api/generate-quiz] Paramètres reçus :", req.body);

    // Récupérer tous les paramètres possibles
    const { difficulty, category, period, episode, moment, geographical_sphere, entity } = req.body;

    // LOG 2 : Vérification des paramètres principaux (les seuls vraiment obligatoires)
    if (!difficulty || !category || !period || !geographical_sphere || !entity) {
      console.error("[/api/generate-quiz] Paramètres principaux manquants !");
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Construire la description du contexte historique selon les paramètres reçus
    let contextString = `pendant la période historique ${period}`;
    if (episode && episode.trim().length > 0) {
      contextString += `, épisode "${episode}"`;
    }
    if (moment && moment.trim().length > 0) {
      contextString += ` (moment : ${moment})`;
    }

    // Construction du prompt dynamique, compatible tous cas (mode libre/parcours, épisode ou non, moment ou non)
    const prompt = `Génère exactement 5 questions à choix multiple sur ${category} concernant la zone géographique ${geographical_sphere} et plus précisément sur ${entity} ${contextString}. Chaque question doit avoir exactement 4 propositions de réponse distinctes et indiquer la bonne réponse. Retourne UNIQUEMENT le JSON suivant, sans aucun texte supplémentaire, sans markdown (pas de \`\`\`json ou autre), sans explications hors du JSON, et sans aucun autre contenu :
[
  {
    "question": "Texte de la question",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "answer": "Option correcte",
    "explanation": "Explication de la réponse correcte"
  }
]
La difficulté des questions est ${difficulty}. L'échelle est la suivante : easy (un seul choix correct évident), medium (quelques choix multiples avec des options plausibles), hard (pièges et questions complexes à choix multiple). Assure-toi que chaque objet dans le tableau contient exactement les champs "question", "options" (un tableau de 4 chaînes), "answer" (une des options), et "explanation" (une explication claire).`;

    console.log("[/api/generate-quiz] Prompt envoyé :", prompt);

    // LOG 3 : Présence de la clé API
    console.log("[/api/generate-quiz] Clé API présente :", !!process.env.DEEPSEEK_API_KEY);

    // LOG 4 : Payload DeepSeek
    const payload = {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'You are a history expert who creates educational quiz questions.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7
    };
    console.log("[/api/generate-quiz] Payload DeepSeek :", JSON.stringify(payload));

    // LOG 5 : Appel à l'API DeepSeek
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
      // LOG 6 : Erreur lors de l'appel à DeepSeek
      console.error("[/api/generate-quiz] Erreur lors de l'appel à DeepSeek :", apiError.response ? apiError.response.data : apiError.message);
      return res.status(500).json({ 
        error: 'Erreur lors de l\'appel à DeepSeek',
        details: apiError.response ? apiError.response.data : apiError.message
      });
    }

    // LOG 7 : Extraction du contenu
    const content = response.data.choices?.[0]?.message?.content;
    if (!content) {
      console.error("[/api/generate-quiz] Contenu vide ou structure inattendue :", response.data);
      return res.status(500).json({ 
        error: 'Empty or invalid API response',
        details: 'No content found in API response'
      });
    }
    console.log("[/api/generate-quiz] Contenu reçu :", content);

    let questions;
    try {
      // LOG 8 : Parsing JSON
      questions = JSON.parse(content);
      console.log("[/api/generate-quiz] Parsing JSON réussi !");
    } catch (parseError) {
      // LOG 9 : Parsing échoué, tentative d'extraction
      console.warn("[/api/generate-quiz] Parsing JSON échoué, tentative d'extraction du JSON du texte...");

      // Clean up markdown and extra text
      let cleanedContent = content
        .replace(/```json\n?/, '') // Remove opening ```json
        .replace(/\n?```/, '')     // Remove closing ```
        .trim();                   // Remove leading/trailing whitespace

      // Extract JSON array
      const jsonMatch = cleanedContent.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          questions = JSON.parse(jsonMatch[0]);
          console.log("[/api/generate-quiz] Extraction JSON réussie !");
        } catch (extractError) {
          console.error("[/api/generate-quiz] Extraction JSON échouée :", extractError);
          return res.status(500).json({ 
            error: 'Failed to parse API response (extraction)',
            details: extractError.message
          });
        }
      } else {
        console.error("[/api/generate-quiz] Impossible d'extraire du JSON du texte :", cleanedContent);
        return res.status(500).json({ 
          error: 'Failed to parse API response',
          details: parseError.message
        });
      }
    }

    // LOG 10 : Validate JSON structure
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
      if (!q.question || !Array.isArray(q.options) || q.options.length !== 4 || !q.answer || !q.explanation) {
        console.error("[/api/generate-quiz] Question invalide à l'index", i, ":", q);
        return res.status(500).json({ 
          error: 'Invalid question structure',
          details: `Question at index ${i} is missing required fields or has invalid options`
        });
      }
      if (!q.options.includes(q.answer)) {
        console.error("[/api/generate-quiz] Réponse invalide à l'index", i, ":", q.answer);
        return res.status(500).json({ 
          error: 'Invalid answer',
          details: `Answer at index ${i} does not match any option`
        });
      }
    }

    // LOG 11 : Succès final
    console.log("[/api/generate-quiz] Quiz généré avec succès !");
    res.json(questions);

  } catch (error) {
    // LOG 12 : Erreur inattendue
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
