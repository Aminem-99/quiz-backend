import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

console.log('[DEBUG] Raw SUPABASE_ANON_KEY:', process.env.SUPABASE_ANON_KEY);
console.log('[DEBUG] SUPABASE_URL:', process.env.SUPABASE_URL);

const cleanSupabaseKey = process.env.SUPABASE_ANON_KEY?.replace(/^=+/, '');
console.log('[DEBUG] Supabase Key nettoyée:', cleanSupabaseKey);

const supabase = createClient(
  process.env.SUPABASE_URL,
  cleanSupabaseKey
);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ── In-memory dedup guard (évite les doubles appels simultanés) ───────────────
const pendingGenerations = new Map();

// ── Helper : appel DeepSeek avec timeout et max_tokens ───────────────────────
async function callDeepSeek(prompt, difficulty) {
  const aiPayload = {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: 'You are a history expert who creates educational quiz questions. Reply only with valid JSON.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.7,
    max_tokens: 1800, // ✅ FIX: limite les tokens — 5 questions = ~800-1200 tokens
  };

  const response = await axios.post(
    'https://api.deepseek.com/v1/chat/completions',
    aiPayload,
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      timeout: 35000, // ✅ FIX: 35s timeout — évite les requêtes zombies sur Railway cold start
    }
  );

  const content = response.data.choices?.[0]?.message?.content;
  let questions;
  try {
    questions = JSON.parse(content);
  } catch {
    let cleaned = content.trim()
      .replace(/```(?:json)?/g, '')
      .replace(/```/g, '')
      .trim();
    const match = cleaned.match(/\[\s*{[\s\S]*}\s*]/);
    if (match) cleaned = match[0];
    questions = JSON.parse(cleaned);
  }

  if (!Array.isArray(questions)) throw new Error('Response is not an array');
  return questions;
}

// ── Helper : build prompt ─────────────────────────────────────────────────────
function buildPrompt(category, period, episode, moment, geographical_sphere, ID_Name, mode, difficulty) {
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
  return `Génère en français 5 questions à choix multiple comme si tu étais un professeur de la matière suivante : ${category}. ${contexte}
Certaines questions doivent avoir plusieurs bonnes réponses (minimum 1, maximum 3), indique-les dans un tableau "answer": ["Option correcte 1", "Option correcte 2"].
Ajoute aussi une propriété "multi": true si la question a plusieurs bonnes réponses, sinon "multi": false.
Chaque question doit avoir 4 propositions de réponse différentes.
Retourne UNIQUEMENT le JSON, sous la forme d'une liste d'objets :
[
  {
    "question": "Texte de la question",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "answer": ["Option correcte 1"],
    "explanation": "Explication courte",
    "multi": false
  }
]
La difficulté des questions est ${difficulty}. Ne réponds que par le JSON.`;
}

/**
 * Générer un quiz (solo OU multi selon présence matchId)
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
      mode,
      matchId
    } = req.body;

    console.log('[generate-quiz] Payload reçu:', req.body);

    if (!difficulty || !category) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // ===============================
    // ------ MODE MULTIJOUEUR -------
    // ===============================
    if (matchId) {
      const { data: match, error: matchError } = await supabase
        .from('quiz_match')
        .select('quiz_payload, difficulty, category, period, geographical_sphere, ID_Name, moment, episode, mode, status')
        .eq('id', matchId)
        .single();

      if (matchError || !match) {
        return res.status(404).json({ error: 'Match not found', details: matchError?.message });
      }

      if (match.quiz_payload) {
        console.log(`[generate-quiz] Quiz déjà généré pour match ${matchId}`);
        return res.json(match.quiz_payload);
      }
      if (match.status !== 'waiting') {
        return res.status(409).json({ error: 'Quiz déjà généré ou match déjà commencé.' });
      }

      // Dedup guard multi
      if (pendingGenerations.has(matchId)) {
        console.log(`[generate-quiz] Dedup: attente génération en cours pour match ${matchId}`);
        const result = await pendingGenerations.get(matchId);
        return res.json(result);
      }

      const genPromise = (async () => {
        const prompt = buildPrompt(match.category, match.period, match.episode, match.moment, match.geographical_sphere, match.ID_Name, match.mode, match.difficulty);
        const questions = await callDeepSeek(prompt, match.difficulty);

        const { data: updated } = await supabase
          .from('quiz_match')
          .update({ quiz_payload: questions, status: 'ready' })
          .eq('id', matchId)
          .is('quiz_payload', null)
          .eq('status', 'waiting')
          .select('quiz_payload');

        if (updated?.[0]?.quiz_payload) return updated[0].quiz_payload;

        const { data: finalMatch } = await supabase
          .from('quiz_match')
          .select('quiz_payload')
          .eq('id', matchId)
          .single();
        return finalMatch?.quiz_payload;
      })();

      pendingGenerations.set(matchId, genPromise);
      genPromise.finally(() => pendingGenerations.delete(matchId));

      const questions = await genPromise;
      return res.json(questions);
    }

    // ===============================
    // --------- MODE SOLO -----------
    // ===============================

    // ✅ FIX: Cache Supabase — évite de rappeler DeepSeek pour le même quiz
    const cacheKey = { difficulty, category, period: period || null, geographical_sphere: geographical_sphere || null, ID_Name: ID_Name || null, moment: moment || null, episode: episode || null };

    let cacheQuery = supabase
      .from('quiz_cache')
      .select('quiz_json')
      .eq('difficulty', difficulty)
      .eq('category', category);
    if (period)               cacheQuery = cacheQuery.eq('period', period);
    if (geographical_sphere)  cacheQuery = cacheQuery.eq('geographical_sphere', geographical_sphere);
    if (ID_Name)              cacheQuery = cacheQuery.eq('ID_Name', ID_Name);
    if (moment)               cacheQuery = cacheQuery.eq('moment', moment);
    if (episode)              cacheQuery = cacheQuery.eq('episode', episode);

    const { data: cached } = await cacheQuery.order('created_at', { ascending: false }).limit(10);

    // ✅ FIX: seuil abaissé à 2 (avant : 5 — impossible à atteindre avec peu d'utilisateurs)
    if (cached && cached.length >= 2) {
      const idx = Math.floor(Math.random() * cached.length);
      console.log(`[generate-quiz] Cache hit (${cached.length} quizs dispo), renvoi quiz #${idx}`);
      return res.json(cached[idx].quiz_json);
    }

    // ✅ FIX: Dedup in-memory pour éviter doubles appels simultanés (StrictMode / double clic)
    const dedupKey = JSON.stringify(cacheKey);
    if (pendingGenerations.has(dedupKey)) {
      console.log('[generate-quiz] Dedup: réutilisation requête en cours');
      const result = await pendingGenerations.get(dedupKey);
      return res.json(result);
    }

    console.log(`[generate-quiz] Cache miss (${cached?.length ?? 0} quizs), appel DeepSeek`);

    const genPromise = (async () => {
      const prompt = buildPrompt(category, period, episode, moment, geographical_sphere, ID_Name, mode, difficulty);
      const questions = await callDeepSeek(prompt, difficulty);

      // ✅ FIX: Stocker en cache pour les prochains appels
      const { error: insertError } = await supabase
        .from('quiz_cache')
        .insert([{
          difficulty,
          category,
          period: period || null,
          geographical_sphere: geographical_sphere || null,
          ID_Name: ID_Name || null,
          moment: moment || null,
          episode: episode || null,
          quiz_json: questions,
        }]);
      if (insertError) console.warn('[generate-quiz] Cache insert error:', insertError.message);
      else console.log('[generate-quiz] Quiz mis en cache');

      return questions;
    })();

    pendingGenerations.set(dedupKey, genPromise);
    genPromise.finally(() => setTimeout(() => pendingGenerations.delete(dedupKey), 500));

    const questions = await genPromise;
    return res.json(questions);

  } catch (error) {
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

    console.log('[submit-answers] Payload reçu:', req.body);

    if (!user_id || !answers || !quiz || !difficulty || !category || !period || !geographical_sphere) {
      return res.status(400).json({ error: 'Missing required parameters for score submission' });
    }

    let correct_answers = 0;
    const total_questions = quiz.length;
    const corrections = quiz.map((question, idx) => {
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

    const { data, error } = await supabase
      .from('quiz_scores')
      .insert([payload])
      .select();

    if (error) {
      console.error('[submit-answers] Supabase error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    res.json({ corrections, score, data: data?.[0] || null });
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
    const { data, error } = await supabase
      .from('quiz_leaderboard')
      .select('user_id,username,total_score,highest_score,average_score,last_quiz_date,avatar_url')
      .order('total_score', { ascending: false })
      .limit(10);

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch leaderboard', details: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
