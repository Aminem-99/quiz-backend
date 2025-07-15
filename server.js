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

    const { difficulty, category, period, geographical_sphere } = req.body;

    // LOG 2 : Vérification des paramètres
    if (!difficulty || !category || !period || !geographical_sphere) {
      console.error("[/api/generate-quiz] Paramètres manquants !");
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // LOG 3 : Construction du prompt
    const prompt = `Génère 5 questions à choix multiple comme si tu étais un professeur de la matière suivante:${category} concernant la zone géographique ${geographical_sphere} pendant la période historique ${period}. Chaque question doit avoir 4 propositions de réponse différentes et indiquer la bonne réponse. Retourne le résultat au format JSON, sous la forme d'une liste d'objets :
[
  {
    "question": "Texte de la question",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "answer": "Option correcte",
    "explication": "Explication de la réponse"
  }
]
La difficulté des questions est ${difficulty}. Ne réponds que par le JSON strictement, sans texte avant ou après.`;
    console.log("[/api/generate-quiz] Prompt envoyé :", prompt);

    // LOG 4 : Présence de la clé API
    console.log("[/api/generate-quiz] Clé API présente :", !!process.env.DEEPSEEK_API_KEY);

    // LOG 5 : Payload DeepSeek
    const payload = {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'You are a history expert who creates educational quiz questions. Always respond with valid JSON only.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7
    };
    console.log("[/api/generate-quiz] Payload DeepSeek :", JSON.stringify(payload, null, 2));

    // LOG 6 : Appel à l'API DeepSeek
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
          timeout: 30000 // 30 secondes de timeout
        }
      );
      console.log("[/api/generate-quiz] Status code DeepSeek :", response.status);
      console.log("[/api/generate-quiz] Réponse complète DeepSeek :", JSON.stringify(response.data, null, 2));
    } catch (apiError) {
      // LOG 7 : Erreur lors de l'appel à DeepSeek
      console.error("[/api/generate-quiz] Erreur lors de l'appel à DeepSeek :");
      console.error("Status:", apiError.response?.status);
      console.error("Data:", apiError.response?.data);
      console.error("Message:", apiError.message);
      return res.status(500).json({ 
        error: 'Erreur lors de l\'appel à DeepSeek',
        details: apiError.response?.data || apiError.message
      });
    }

    // LOG 8 : Extraction du contenu
    const messageContent = response.data.choices?.[0]?.message?.content;
    console.log("[/api/generate-quiz] Contenu du message reçu :", messageContent);

    if (!messageContent) {
      console.error("[/api/generate-quiz] Aucun contenu reçu de DeepSeek");
      return res.status(500).json({ 
        error: 'Aucun contenu reçu de DeepSeek',
        details: 'La réponse est vide'
      });
    }

    let questions;
    try {
      // LOG 9 : Nettoyage du contenu
      let cleanContent = messageContent.trim();
      
      // Supprimer les balises markdown si présentes
      cleanContent = cleanContent.replace(/```json|```/g, '').trim();
      
      // Supprimer tout texte avant le premier [
      const startIndex = cleanContent.indexOf('[');
      if (startIndex > 0) {
        cleanContent = cleanContent.substring(startIndex);
      }
      
      // Supprimer tout texte après le dernier ]
      const endIndex = cleanContent.lastIndexOf(']');
      if (endIndex !== -1 && endIndex < cleanContent.length - 1) {
        cleanContent = cleanContent.substring(0, endIndex + 1);
      }
      
      console.log("[/api/generate-quiz] Contenu nettoyé :", cleanContent);
      
      // Parsing JSON
      questions = JSON.parse(cleanContent);
      console.log("[/api/generate-quiz] Parsing JSON réussi !");
      console.log("[/api/generate-quiz] Questions parsées :", JSON.stringify(questions, null, 2));
      
    } catch (parseError) {
      // LOG 10 : Parsing échoué, tentative d'extraction plus agressive
      console.warn("[/api/generate-quiz] Parsing JSON échoué, tentative d'extraction du JSON du texte...");
      console.error("[/api/generate-quiz] Erreur de parsing :", parseError.message);
      
      // Tentative d'extraction du JSON avec regex plus robuste
      const jsonMatch = messageContent.match(/\[[\s\S]*?\]/);
      if (jsonMatch) {
        try {
          questions = JSON.parse(jsonMatch[0]);
          console.log("[/api/generate-quiz] Extraction JSON réussie avec regex !");
        } catch (extractError) {
          console.error("[/api/generate-quiz] Extraction JSON échouée avec regex :", extractError.message);
          return res.status(500).json({ 
            error: 'Failed to parse API response (extraction)',
            details: extractError.message,
            rawContent: messageContent
          });
        }
      } else {
        console.error("[/api/generate-quiz] Impossible d'extraire du JSON du texte.");
        return res.status(500).json({ 
          error: 'Failed to parse API response - no JSON found',
          details: parseError.message,
          rawContent: messageContent
        });
      }
    }

    // LOG 11 : Validation des questions
    if (!Array.isArray(questions)) {
      console.error("[/api/generate-quiz] Le résultat n'est pas un tableau");
      return res.status(500).json({ 
        error: 'Invalid response format - not an array',
        details: 'Expected an array of questions'
      });
    }

    if (questions.length === 0) {
      console.error("[/api/generate-quiz] Aucune question générée");
      return res.status(500).json({ 
        error: 'No questions generated',
        details: 'The array is empty'
      });
    }

    // Validation de la structure des questions
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q.question || !q.options || !q.answer) {
        console.error(`[/api/generate-quiz] Question ${i + 1} mal formée:`, q);
        return res.status(500).json({ 
          error: `Question ${i + 1} has invalid format`,
          details: 'Missing required fields: question, options, or answer'
        });
      }
      
      if (!Array.isArray(q.options) || q.options.length !== 4) {
        console.error(`[/api/generate-quiz] Question ${i + 1} n'a pas 4 options:`, q.options);
        return res.status(500).json({ 
          error: `Question ${i + 1} must have exactly 4 options`,
          details: 'Each question must have 4 answer choices'
        });
      }
    }

    // LOG 12 : Succès final
    console.log("[/api/generate-quiz] Quiz généré avec succès !");
    console.log("[/api/generate-quiz] Nombre de questions :", questions.length);
    
    res.json({
      success: true,
      quiz: questions,
      metadata: {
        difficulty,
        category,
        period,
        geographical_sphere,
        questionCount: questions.length
      }
    });

  } catch (error) {
    // LOG 13 : Erreur inattendue
    console.error("[/api/generate-quiz] Erreur inattendue :", error);
    res.status(500).json({ 
      error: 'Failed to generate quiz questions',
      details: error.message
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Server is running',
    timestamp: new Date().toISOString(),
    env: {
      port: PORT,
      hasDeepSeekKey: !!process.env.DEEPSEEK_API_KEY
    }
  });
});

// Endpoint pour tester l'API DeepSeek
app.get('/api/test-deepseek', async (req, res) => {
  try {
    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [
          { role: 'user', content: 'Hello, respond with just "API working"' }
        ],
        temperature: 0.1
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
        }
      }
    );
    
    res.json({
      status: 'success',
      response: response.data.choices[0].message.content
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.response?.data || error.message
    });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`API endpoint available at http://localhost:${PORT}/api/generate-quiz`);
  console.log(`Health check available at http://localhost:${PORT}/api/health`);
  console.log(`DeepSeek test available at http://localhost:${PORT}/api/test-deepseek`);
});
