import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

// Chargement des variables d'environnement
dotenv.config();

console.log('[DEBUG] Raw SUPABASE_ANON_KEY:', process.env.SUPABASE_ANON_KEY);
console.log('[DEBUG] SUPABASE_URL:', process.env.SUPABASE_URL);

// Nettoyage de la clé si elle commence par un égal
const cleanSupabaseKey = process.env.SUPABASE_ANON_KEY?.replace(/^=+/, '');
console.log('[DEBUG] Supabase Key nettoyée:', cleanSupabaseKey);

// Initialisation du client Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  cleanSupabaseKey
);

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

/**
 * Générer un quiz via DeepSeek avec cache — PATCH ANTI-GÉNÉRATION MULTIPLE
 */
app.post('/api/generate-quiz', async (req, res) => {
  try {
    const {
      difficulty,
      category,
      period,
      geographical_sphere,
      ID_Name,
      moment,
      episode,
      mode
    } = req.body;

    // LOG: paramètres reçus
    console.log('[generate-quiz] Payload reçu:', req.body);

    // Vérification des paramètres requis
    if (!difficulty || !category) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Recherche du quiz en cache pour cette config (une seule occurrence !)
    let cacheQuery = supabase
      .from('quiz_cache')
      .select('quiz_json')
      .eq('difficulty', difficulty)
      .eq('category', category);

    if (period) cacheQuery = cacheQuery.eq('period', period);
    if (geographical_sphere) cacheQuery = cacheQuery.eq('geographical_sphere', geographical_sphere);
    if (ID_Name) cacheQuery = cacheQuery.eq('ID_Name', ID_Name);
    if (moment) cacheQuery = cacheQuery.eq('moment', moment);
    if (episode) cacheQuery = cacheQuery.eq('episode', episode);

    const { data: cachedQuizzes, error: cacheError } = await cacheQuery
      .order('created_at', { ascending: false });

    if (cacheError) {
      console.warn('[generate-quiz] Erreur recherche cache quiz:', cacheError.message);
    }

    // PATCH: si au moins un quiz existe, on ne génère rien !
    if (cachedQuizzes && cachedQuizzes.length > 0) {
      console.log('[generate-quiz] Quiz trouvé en cache, PAS de génération AI !');
      return res.json(cachedQuizzes[0].quiz_json);
    }

    // —————————————————————————————
    // Si aucun quiz trouvé, on génère UNE FOIS !
    // —————————————————————————————
    const contexte = `
Tu es professeur d'histoire. 
Sujet du quiz : ${category}
Période : ${period || 'non précisée'}
Épisode : ${episode || 'non précisé'}
Moment clé : ${moment || 'non précisé'}
Zone géographique : ${geographical_sphere || 'non précisée'}
Pays/Région : ${ID_Name || 'non précisé'}
Mode : ${mode || 'standard'}
`;

    let promptIntro = `Génère en français 5 questions à choix multiple comme si tu étais un professeur de la matière suivante : ${category}. `;
    const prompt = `${promptIntro}${contexte}
Certaines questions doivent avoir plusieurs bonnes réponses (minimum 1, maximum 3), indique-les dans un tableau "answer": ["Option correcte 1", "Option correcte 2"]. 
Ajoute aussi une propriété "multi": true si la question a plusieurs bonnes réponses, sinon "multi": false.
Chaque question doit avoir 4 propositions de réponse différentes.
Retourne le résultat au format JSON, sous la forme d'une liste d'objets :
[
  {
    "question": "Texte de la question",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "answer": ["Option correcte 1", "Option correcte 2"],
    "explanation": "Explication de la bonne réponse",
    "multi": true
  }
]
Si une question n'a qu'une bonne réponse, "answer" doit être un tableau avec un seul élément et "multi": false.
La difficulté des questions est ${difficulty}. Ne réponds que par le JSON, mais ajoute une explication supplémentaire.`;

    const aiPayload = {
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
        aiPayload,
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          }
        }
      );
    } catch (apiErr) {
      console.error('[generate-quiz] DeepSeek API error:', apiErr.response?.data || apiErr.message);
      return res.status(500).json({ error: 'Failed to call DeepSeek API', details: apiErr.response?.data || apiErr.message });
    }

    const content = response.data.choices?.[0]?.message?.content;
    let questions;
    try {
      questions = JSON.parse(content);
    } catch (parseErr) {
      console.warn('[generate-quiz] Parsing brut échoué, tentative extraction JSON:', content);

      let cleanedContent = content.trim();
      cleanedContent = cleanedContent.replace(/```(?:json)?/g, '').replace(/```/g, '').trim();
      const arrayMatch = cleanedContent.match(/\[\s*{[\s\S]*}\s*]/);
      if (arrayMatch) {
        cleanedContent = arrayMatch[0];
      }

      try {
        questions = JSON.parse(cleanedContent);
      } catch (parseErr2) {
        console.error('[generate-quiz] Parsing JSON échoué après nettoyage:', parseErr2.message);
        return res.status(500).json({ error: 'Failed to parse DeepSeek response JSON', details: parseErr2.message });
      }
    }

    // LOG: Quiz généré
    console.log('[generate-quiz] Quiz généré:', questions);

    // AJOUT : écriture dans le cache
    const { error: insertError } = await supabase.from('quiz_cache').insert([{
      difficulty,
      category,
      period,
      geographical_sphere,
      ID_Name,
      moment,
      episode,
      quiz_json: questions
    }]);

    if (insertError) {
      console.error('[generate-quiz] Erreur INSERT cache:', insertError.message);
    } else {
      console.log('[generate-quiz] Quiz sauvegardé dans quiz_cache.');
    }

    res.json(questions);
  } catch (error) {
    // LOG: Erreur globale
    console.error('[generate-quiz] Server error:', error);
    res.status(500).json({ error: 'Failed to generate quiz questions', details: error.message });
  }
});

/**
 * Soumission des réponses utilisateur, stockage dans Supabase
 */
app.post('/api/submit-answers', async (req, res) => {
  try {
    const {
      user_id,
      answers,
      quiz,
      difficulty,
      category,
      period,
      geographical_sphere,
      time_taken
    } = req.body;

    // LOG: Payload reçu
    console.log('[submit-answers] Payload reçu:', req.body);

    if (!user_id || !answers || !quiz || !difficulty || !category || !period || !geographical_sphere) {
      return res.status(400).json({ error: 'Missing required parameters for score submission' });
    }

    let correct_answers = 0;
    const total_questions = quiz.length;
    const corrections = quiz.map((question, idx) => {
      // Multi réponse compatible
      const userAnswerArr = Array.isArray(answers[idx]) ? answers[idx] : [answers[idx]];
      const correctAnswerArr = Array.isArray(question.answer) ? question.answer : [question.answer];
      const isCorrect = userAnswerArr.length === correctAnswerArr.length &&
        userAnswerArr.every(ans => correctAnswerArr.includes(ans));
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

    console.log('[submit-answers] Payload:', payload);

    const { data, error } = await supabase
      .from('quiz_scores')
      .insert([payload])
      .select();

    if (error) {
      console.error('[submit-answers] Supabase error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    console.log('[submit-answers] Score enregistré:', data?.[0]);

    res.json({
      corrections,
      score,
      data: data?.[0] || null
    });
  } catch (error) {
    console.error('[submit-answers] Server error:', error);
    res.status(500).json({ error: 'Failed to submit answers', details: error.message });
  }
});

/**
 * Leaderboard global (Top 10)
 */
app.get('/api/leaderboard', async (req, res) => {
  try {
    console.log('[leaderboard] Requête leaderboard');

    const { data, error } = await supabase
      .from('quiz_leaderboard')
      .select('user_id,username,total_score,highest_score,average_score,last_quiz_date,avatar_url')
      .order('total_score', { ascending: false })
      .limit(10);

    if (error) {
      console.error('[leaderboard] Supabase error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    res.json(data);
  } catch (error) {
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
