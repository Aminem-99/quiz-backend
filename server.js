import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

app.use(cors());
app.use(express.json());

/**
 * Générer un quiz via DeepSeek (pas de stockage)
 */
app.post('/api/generate-quiz', async (req, res) => {
  try {
    const {
      difficulty,
      category,
      period,
      geographical_sphere,
      id_name,
      moment,
      episode
    } = req.body;

    // LOG: paramètres reçus
    console.log('[generate-quiz] Payload reçu:', req.body);

    if (!difficulty || !category) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Construction du prompt selon la logique demandée
    let promptIntro = `Génère 5 questions à choix multiple comme si tu étais un professeur de la matière suivante : ${category} `;
    let contexte = "";

    if (ID_Name) {
      contexte += `concernant l'entité politique "${ID_Name}" `;
      // On ne met PAS la zone géographique si id_name présent
    } else if (geographical_sphere) {
      contexte += `concernant la zone géographique ${geographical_sphere} `;
    }

    if (moment && episode) {
      contexte += `(épisode : ${episode}, moment : ${moment}) `;
      // On NE met PAS la période s'ils sont tous les deux présents
    } else if (period) {
      contexte += `pendant la période historique ${period} `;
      if (episode) contexte += `(épisode : ${episode}) `;
      if (moment) contexte += `(moment : ${moment}) `;
    } else {
      if (episode) contexte += `(épisode : ${episode}) `;
      if (moment) contexte += `(moment : ${moment}) `;
    }

    const prompt = `${promptIntro}${contexte}
Chaque question doit avoir 4 propositions de réponse différentes et indiquer la bonne réponse. Retourne le résultat au format JSON, sous la forme d'une liste d'objets :
[
  {
    "question": "Texte de la question",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "answer": "Option correcte",
    "explanation": "Explication de la bonne réponse"
  }
]
La difficulté des questions est ${difficulty}. Ne réponds que par le JSON, mais ajoute une explication supplémentaire.`;

    const payload = {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'You are a history expert who creates educational quiz questions.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7
    };

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
    } catch (apiErr) {
      // LOG: Erreur DeepSeek
      console.error('[generate-quiz] DeepSeek API error:', apiErr.response?.data || apiErr.message);
      return res.status(500).json({ error: 'Failed to call DeepSeek API', details: apiErr.response?.data || apiErr.message });
    }

    const content = response.data.choices?.[0]?.message?.content;
    let questions;
    try {
      questions = JSON.parse(content);
    } catch (parseErr) {
      // LOG: Parsing JSON brut échoué
      console.warn('[generate-quiz] Parsing brut échoué, tentative extraction JSON:', content);

      let cleanedContent = content.trim();
      if (cleanedContent.startsWith('```')) {
        cleanedContent = cleanedContent.replace(/```json|```/g, '').trim();
      }
      try {
        questions = JSON.parse(cleanedContent);
      } catch (parseErr2) {
        console.error('[generate-quiz] Parsing JSON échoué après nettoyage:', parseErr2.message);
        return res.status(500).json({ error: 'Failed to parse DeepSeek response JSON', details: parseErr2.message });
      }
    }

    // LOG: Quiz généré
    console.log('[generate-quiz] Quiz Quiz généré:', questions);

    res.json(questions);
  } catch (error) {
    console.error('[generate-quiz] Server error:', error);
    res.status(500).json({ error: 'Failed to generate quiz questions', details: error.message });
  }
});

/**
 * Soumission des réponses utilisateur, stockage dans Supabase
 */
app.post('/**submit-answers**', async (req, res) => {
  try {
    const {
      user_id,
      answers,            // tableau des réponses de l'utilisateur
      quiz,               // tableau des questions avec réponses correctes et explications
      difficulty,
      category,
      period,
      geographical_sphere,
      time_taken          // optionnel
    } = req.body;

    // LOG: Payload reçu
    console.log('[submit-answers] Payload reçu:', req.body);

    if (!user_id || !answers || !quiz || !difficulty || !category || !period || !geographical_sphere) {
      return res.status(400).json({ error: 'Missing required parameters for score submission' });
    }

    // Correction des réponses utilisateur
    let correct_answers = 0;
    const total_questions = quiz.length;
    const corrections = quiz.map((question, idx) => {
      const isCorrect = answers[idx] === question.answer;
      if (isCorrect) correct_answers++;
      return {
        question: question.question,
        user_answer: answers[idx],
        correct_answer: question.answer,
        is_correct: isCorrect,
        explanation: question.explanation
      };
    });
    const score = correct_answers;

    // Insérer score dans quiz_scores
    const payload = {
      user_id,
      score,
      difficulty,
      category,
      period,
      geographical_sphere,
      total_questions,
      time_taken,
      correct_answers
    };

    // Log le payload pour debug
    console.log('[submit-answers] Payload:', payload);

    // Insertion dans promo
    const { data, error } = await supabase
      .from('quiz_scores')
      .insert([payload])
      .select();

    if (error) {
      // LOG: Erreur Supabase
      console.error('[submit-answers] Supabase error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    // LOG: Score enregistré
    console.log('[submit-answers] Score enregistré:', data?.[0]);

    res.json({
      corrections,
      score,
      data: data?.[0] || null
    });
  } catch (error) {
    // LOG: Erreur globale
    console.error('[submit-answers] Server error:', error);
    res.status(500).json({ error: 'Failed to submit answers', details: error.message });
  }
});

/**
 * Leaderboard global (Top  10)
 */
app.get('/api/leaderboard', async (req, res) => {
  try {
    // LOG: requête leaderboard
    console.log('[leaderboard] Requête leaderboard');

    const { data, error } = await supabase
      .from('quiz_leaderboard')
      .select('user_id,username,total_score,highest_score,average_score,last_quiz_date,avatar_url')
      .order('total_score', { ascending: false })
      .limit(10);

    if (error) {
      // LOG: Erreur leaderboard
      console.error('[leaderboard] Supabase error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    res.json(data);
  } catch (error) {
    // LOG: Erreur globale
    console.error('[leaderboard] Server error:', error);
    res.status(500).json({ error: 'Failed to fetch leaderboard', details: error.message });
  }
});

/**
 * Endpoint de santé
 */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
