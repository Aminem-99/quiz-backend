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
      matchId // multi uniquement
    } = req.body;

    // Log
    console.log('[generate-quiz] Payload reçu:', req.body);

    if (!difficulty || !category) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // ===============================
    // ------ MODE MULTIJOUEUR -------
    // ===============================
    if (matchId) {
      // Récupération ultra safe du match
      const { data: match, error: matchError } = await supabase
        .from('quiz_match')
        .select('quiz_payload, difficulty, category, period, geographical_sphere, ID_Name, moment, episode, mode, status')
        .eq('id', matchId)
        .single();

      if (matchError || !match) {
        return res.status(404).json({ error: 'Match not found', details: matchError?.message });
      }

      // Backend ultra safe : ne génère QUE si quiz_payload est null ET status "waiting"
      if (match.quiz_payload) {
        console.log(`[generate-quiz] Quiz déjà généré pour match ${matchId}, renvoi du payload existant`);
        return res.json(match.quiz_payload);
      }
      if (match.status !== 'waiting') {
        // Si le match n'est pas en attente, on ne génère pas
        console.log(`[generate-quiz] Match ${matchId} status n'est pas 'waiting', renvoi quiz_payload ou erreur`);
        // On renvoie le quiz ou une erreur explicite
        return res.status(409).json({ error: 'Quiz déjà généré ou match déjà commencé.' });
      }

      // Génération du quiz (avec la config du match)
      const contexte = `
Tu es professeur d'histoire. 
Sujet du quiz : ${match.category}
Période : ${match.period || 'non précisée'}
Épisode : ${match.episode || 'non précisé'}
Moment clé : ${match.moment || 'non précisé'}
Zone géographique : ${match.geographical_sphere || 'non précisée'}
Pays/Région : ${match.ID_Name || 'non précisé'}
Mode : ${match.mode || 'standard'}
`;

      let promptIntro = `Génère en français 5 questions à choix multiple comme si tu étais un professeur de la matière suivante : ${match.category}. `;
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
La difficulté des questions est ${match.difficulty}. Ne réponds que par le JSON, mais ajoute une explication supplémentaire.`;

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

      // Ecriture atomique : update quiz_payload UNIQUEMENT si quiz_payload est encore null ET status "waiting"
const { data: updated, error: updateError } = await supabase
  .from('quiz_match')
  .update({ quiz_payload: questions, status: 'ready' })
  .eq('id', matchId)
  .is('quiz_payload', null)
  .eq('status', 'waiting')
  .select('quiz_payload');

      if (updated && updated.quiz_payload) {
        console.log(`[generate-quiz] Quiz généré et enregistré pour match ${matchId}`);
        return res.json(updated.quiz_payload);
      }
      // Si quelqu'un l'a généré entre-temps, on relit et renvoie
      const { data: finalMatch, error: finalError } = await supabase
        .from('quiz_match')
        .select('quiz_payload')
        .eq('id', matchId)
        .single();
      if (finalError || !finalMatch) {
        return res.status(500).json({ error: 'Failed to retrieve quiz after concurrent generation', details: finalError?.message });
      }
      console.log(`[generate-quiz] Quiz généré concurrent pour match ${matchId}, renvoi quiz_payload`);
      return res.json(finalMatch.quiz_payload);
    }

    // ===============================
    // --------- MODE SOLO -----------
    // ===============================
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

    // On ne stocke rien en solo, on renvoie juste le quiz généré
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

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

