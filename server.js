const xss = require('xss');
const crypto = require('crypto');
const express = require('express');
const Razorpay = require('razorpay');
const cors = require('cors');
const admin = require('firebase-admin');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer'); // 👈 1. Multer imported for file uploads

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

// Configure multer for memory storage (Max 10MB per file)
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } 
});

// ==========================================
// --- SECURITY & MIDDLEWARE CONFIGURATION ---
// ==========================================

app.use(helmet());

app.use(cors({
    origin: ['https://desidealshub.com', 'https://quiz.desidealshub.com', 'http://localhost:3000'],
    methods: ['GET', 'POST']
}));

// PAYLOAD LIMITER (Increased to allow JSON configs)
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

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

// 2. AI Quiz Generation Route (With Credit Deduction, Strict OCR & Optional Subject)
app.post('/api/v1/generate-quiz', upload.array('files', 5), async (req, res) => {
    try {
        // Parse config sent as stringified JSON inside FormData
        let config = {};
        if (req.body.config) {
            try {
                config = JSON.parse(req.body.config);
            } catch (e) {
                config = req.body;
            }
        } else {
            config = req.body;
        }

        const { subject, questionCount, difficulty, targetLevel } = config;

        if (!questionCount) {
            return res.status(400).json({ success: false, error: "Question count zaroori hai." });
        }

        const userId = req.user ? req.user.uid : 'guest_user';
        const qCount = Number(questionCount) || 10;
        
        // Credit calculation: 0.5 per question, minimum 3 credits
        const requiredCredits = Math.max(3, Math.ceil(qCount * 0.5));

        // 1. Check and deduct credits from Firestore (Skipping for guest_user)
        if (userId !== 'guest_user') {
            const userRef = db.collection('users').doc(userId);
            
            try {
                await db.runTransaction(async (transaction) => {
                    const userDoc = await transaction.get(userRef);
                    
                    let currentCredits = 30; // Default new user bonus
                    if (userDoc.exists && userDoc.data().credits !== undefined) {
                        currentCredits = Number(userDoc.data().credits);
                    }

                    if (currentCredits < requiredCredits) {
                        throw new Error(`Insufficient credits! Aapke paas ${currentCredits} credits hain, lekin is quiz ke liye ${requiredCredits} credits chahiye.`);
                    }

                    // Deduct credits safely
                    transaction.set(userRef, { credits: currentCredits - requiredCredits }, { merge: true });
                });
            } catch (dbError) {
                return res.status(400).json({ success: false, error: dbError.message });
            }
        }

        // Subject optional handling (agar khali ho toh AI khud detect karega)
        const finalSubject = (subject && subject.trim() !== "" && subject !== "Select primary subject...") 
            ? subject 
            : "Auto-Detected from Notes / Image Content";

        const prompt = `You are an expert academic examiner and OCR parser. 
        CRITICAL INSTRUCTION: Analyze the attached image/file very carefully. You MUST generate exactly ${qCount} multiple choice questions (MCQs) strictly and exclusively based on the content, text, alphabets, words, objects, or data visible inside the attached image. Do NOT generate generic textbook or grammar questions from your general knowledge if they are not present in the image.
        Primary focus: Extract facts and data directly from the image.
        Subject context (secondary): "${finalSubject}"
        Difficulty: "${difficulty || 'medium'}"
        Target Level: "${targetLevel || 'general'}". 

        You MUST return ONLY a valid JSON array of objects. Do not include markdown formatting like \`\`\`json or any extra conversational text. 
        Each object must strictly match this schema:
        {
          "question": "Question text derived directly from the image content",
          "options": { "A": "...", "B": "...", "C": "...", "D": "..." },
          "correctAnswer": "A",
          "explanation": "Detailed explanation based on the image"
        }`;

        const contents = [prompt];
        
        if (req.files && req.files.length > 0) {
            req.files.forEach(file => {
                contents.push({
                    inlineData: {
                        data: file.buffer.toString("base64"),
                        mimeType: file.mimetype
                    }
                });
            });
        }

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: contents,
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
