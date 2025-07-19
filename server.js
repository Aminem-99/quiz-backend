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

    const { difficulty, category, period, geographical_sphere, entity, moment } = req.body;

    // LOG 2 : Vérification des paramètres
    if (!difficulty || !category || !period || !geographical_sphere || !entity || !moment) {
      console.error("[/api/generate-quiz] Paramètres manquants !");
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // LOG 3 : Construction du prompt
    const prompt = `Génère exactement 5 questions à choix multiple sur ${category} concernant la zone géographique ${geographical_sphere} et plus précisément sur ${entity} pendant la période historique ${period} (${moment}) en respectant strictement les années visées (ex: pour monde multipolaire, de 2022 à aujourd'hui). Chaque question doit avoir exactement 4 propositions de réponse distinctes et indiquer la bonne réponse. Retourne UNIQUEMENT le JSON suivant, sans aucun texte supplémentaire, sans markdown (pas de \`\`\`json ou autre), sans explications hors du JSON, et sans aucun autre contenu :
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

    // LOG 4 : Présence de la clé API
    console.log("[/api/generate-quiz] Clé API présente :", !!process.env.DEEPSEEK_API_KEY);

    // LOG 5 : Payload DeepSeek
    const payload = {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'You are a history expert who creates educational quiz questions.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7
    };
    console.log("[/api/generate-quiz] Payload DeepSeek :", JSON.stringify(payload));

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
          }
        }
      );
      console.log("[/api/generate-quiz] Status code DeepSeek :", response.status);
      console.log("[/api/generate-quiz] Réponse brute DeepSeek :", response.data);
    } catch (apiError) {
      // LOG 7 : Erreur lors de l'appel à DeepSeek
      console.error("[/api/generate-quiz] Erreur lors de l'appel à DeepSeek :", apiError.response ? apiError.response.data : apiError.message);
      return res.status(500).json({ 
        error: 'Erreur lors de l\'appel à DeepSeek',
        details: apiError.response ? apiError.response.data : apiError.message
      });
    }

    // LOG 8 : Extraction du contenu
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
      // LOG 9 : Parsing JSON
      questions = JSON.parse(content);
      console.log("[/api/generate-quiz] Parsing JSON réussi !");
    } catch (parseError) {
      // LOG 10 : Parsing échoué, tentative d'extraction
      console.warn("[/api/generate-quiz] Parsing JSON échoué, tentative d'extraction du JSON du texte...");
      
      // Clean up markdown and extra text
      let cleanedContent = content
        .replace(/```json\n?/, '') // Remove opening ```json:disable-run
        .replace(/\
