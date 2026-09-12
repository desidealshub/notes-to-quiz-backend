const xss = require('xss');
const crypto = require('crypto');
const express = require('express');
const Razorpay = require('razorpay');
const cors = require('cors');
const admin = require('firebase-admin');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// 1. FIREBASE SECURE CONNECTION
try {
    let serviceAccount;
    
    if (process.env.FIREBASE_CREDENTIALS) {
        serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
        console.log("🟢 Loaded Firebase credentials from Environment Variable.");
    } else {
        serviceAccount = require('./serviceAccountKey.json');
        console.log("🟡 Loaded Firebase credentials from local serviceAccountKey.json file.");
    }

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    
    console.log("✅ Firebase Admin Connected Successfully!");
} catch (err) {
    console.error("🚨 Firebase Init Error:", err);
}

const db = admin.firestore();
const app = express();

// ==========================================
// --- SECURITY & MIDDLEWARE CONFIGURATION ---
// ==========================================

app.use(helmet());

app.use(cors({
    origin: ['https://desidealshub.com', 'https://quiz.desidealshub.com', 'http://localhost:3000'],
    methods: ['GET', 'POST']
}));

// PAYLOAD LIMITER (Prevents large payload attacks)
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// ANTI-DDOS / SPAM GUARD (Rate Limiter)
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 50, 
    message: { 
        success: false, 
        error: "Aram se bhai! Bahut zyada requests aagayi hain. 15 minute baad try kar." 
    },
    standardHeaders: true, 
    legacyHeaders: false, 
});

app.use('/api/', apiLimiter);

// ==========================================
// --- INITIALIZE RAZORPAY & AI CLIENT ---
// ==========================================

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_dummykey',
    key_secret: process.env.RAZORPAY_SECRET || 'dummysecret'
});

// GEMINI AI SDK SETUP (Google Gen AI)
const { GoogleGenAI } = require('@google/genai');
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });


// ==========================================
// --- AUTHENTICATION MIDDLEWARE ---
// ==========================================
const verifyAuthToken = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.split('Bearer ')[1];
            const decodedToken = await admin.auth().verifyIdToken(token);
            req.user = { uid: decodedToken.uid, email: decodedToken.email };
        } else {
            // Default fallback for guest testing mode
            req.user = { uid: 'guest_user', email: 'guest@desidealshub.com' };
        }
        next();
    } catch (error) {
        console.warn("⚠️ Auth token verification failed, falling back to guest:", error.message);
        req.user = { uid: 'guest_user', email: 'guest@desidealshub.com' };
        next();
    }
};

// Apply auth middleware globally to all API routes
app.use('/api/v1/', verifyAuthToken);


// ==========================================
// --- API ROUTES ---
// ==========================================

// 1. Health Check Route
app.get('/', (req, res) => {
    res.json({ status: 'NotesToQuiz Production Backend is Live & Secure 🚀' });
});

// 2. AI Quiz Generation Route
app.post('/api/v1/generate-quiz', async (req, res) => {
    try {
        const { subject, questionCount, difficulty, targetLevel } = req.body;

        if (!subject || !questionCount) {
            return res.status(400).json({ success: false, error: "Subject aur question count zaroori hai." });
        }

        const prompt = `You are an expert academic examiner. Generate exactly ${questionCount} multiple choice questions (MCQs) for the subject "${subject}" at "${difficulty || 'medium'}" difficulty level targeting "${targetLevel || 'general'}". 
        You MUST return ONLY a valid JSON array of objects. Do not include markdown formatting like \`\`\`json or any extra conversational text. 
        Each object must strictly match this schema:
        {
          "question": "Question text here",
          "options": { "A": "...", "B": "...", "C": "...", "D": "..." },
          "correctAnswer": "A",
          "explanation": "Detailed explanation here"
        }`;

        const response = await ai.models.generateContent({
            model: 'gemini-1.5-flash',
            contents: prompt,
        });

        const rawText = response.text;
        const cleanedJSON = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        const quizArray = JSON.parse(cleanedJSON);

        res.status(200).json({ success: true, quizArray });
    } catch (error) {
        console.error("🚨 AI Generation Error:", error);
        res.status(500).json({ success: false, error: "AI quiz generation fail ho gaya. Kripya dobara try karein." });
    }
});

// 3. Save Quiz History Route (Firestore)
app.post('/api/v1/save-history', async (req, res) => {
    try {
        const { subject, score, total, quizData, userAnswers, flaggedQuestions } = req.body;
        // req.user.uid automatically middleware se aayega
        const activeUserId = req.user ? req.user.uid : 'guest_user';
        
        const docRef = await db.collection('history').add({
            userId: xss(activeUserId),
            subject: xss(subject || 'General'),
            score: Number(score) || 0,
            total: Number(total) || 0,
            quizData,
            userAnswers: userAnswers || {},
            flaggedQuestions: flaggedQuestions || [],
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.status(200).json({ success: true, recordId: docRef.id });
    } catch (error) {
        console.error("🚨 Firestore Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Production Server running on port ${PORT}`);
});
