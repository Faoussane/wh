require('dotenv').config();

const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express'); // AJOUT IMPORTANT

const app = express(); // CRÉER UN SERVEUR EXPRESS
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const client = new Client({
  authStrategy: new LocalAuth({ clientId: "default" }),
  puppeteer: { 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

// Configuration optimisée
const CONFIG = {
  model: "gemini-1.5-flash",
  maxTokens: 500,
  temperature: 0.7,
  maxHistory: 4,
};

const responseCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000;
let requestCount = 0;
const startTime = Date.now();

// Route de santé pour Render
app.get('/', (req, res) => {
  res.json({ 
    status: 'Bot WhatsApp actif', 
    requests: requestCount,
    uptime: Math.floor((Date.now() - startTime) / 1000) 
  });
});

// Route health check
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// QR Code
client.on('qr', qr => {
  console.log('👉 Scanner ce QR code dans WhatsApp');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('✅ WhatsApp connecté et prêt.');
});

client.on('disconnected', (reason) => {
  console.log('❌ WhatsApp déconnecté:', reason);
});

const conversationHistory = {};

async function askGemini(chatId, userMessage) {
  // Cache check
  const cacheKey = `${chatId}:${userMessage.toLowerCase().trim()}`;
  const cached = responseCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.response;
  }

  if (!conversationHistory[chatId]) {
    conversationHistory[chatId] = [];
  }

  conversationHistory[chatId].push({ 
    role: "user", 
    parts: [{ text: userMessage }] 
  });

  if (conversationHistory[chatId].length > CONFIG.maxHistory) {
    conversationHistory[chatId] = conversationHistory[chatId].slice(-CONFIG.maxHistory);
  }

  try {
    const model = genAI.getGenerativeModel({ 
      model: CONFIG.model
    });
    
    const chat = model.startChat({
      history: conversationHistory[chatId],
      generationConfig: {
        maxOutputTokens: CONFIG.maxTokens,
        temperature: CONFIG.temperature,
      },
    });

    requestCount++;
    console.log(`📊 Requête #${requestCount} - ${new Date().toLocaleTimeString()}`);

    const result = await chat.sendMessage(userMessage);
    const response = await result.response;
    const botMessage = response.text();

    conversationHistory[chatId].push({ 
      role: "model", 
      parts: [{ text: botMessage }] 
    });

    responseCache.set(cacheKey, {
      response: botMessage,
      timestamp: Date.now()
    });

    return botMessage;

  } catch (err) {
    console.error("Erreur Gemini:", err.message);
    
    if (err.status === 429) {
      return "⚠️ Trop de requêtes. Réessayez dans quelques minutes.";
    }
    return "⚠️ Erreur temporaire. Réessayez plus tard.";
  }
}

client.on('message', async msg => {
  if (msg.fromMe) return;

  const chatId = msg.from;
  const text = msg.body.trim();

  // Commandes simples
  if (text === "!ping") return msg.reply("pong 🏓");
  if (text === "!reset") {
    conversationHistory[chatId] = [];
    return msg.reply("🧹 Contexte effacé !");
  }
  if (text === "!help") {
    return msg.reply(`Commandes:
!ping - Test
!reset - Effacer historique
!stats - Statistiques`);
  }
  if (text === "!stats") {
    const hours = ((Date.now() - startTime) / (1000 * 60 * 60)).toFixed(1);
    return msg.reply(`📊 Requêtes: ${requestCount} | Uptime: ${hours}h`);
  }

  // Limites
  if (text.length > 500) {
    return msg.reply("❌ Message trop long (max 500 caractères)");
  }

  if (requestCount > 1000) {
    return msg.reply("⏳ Quota journalier atteint. Réessayez demain.");
  }

  await msg.reply("💭 Je réfléchis...");

  const aiResponse = await askGemini(chatId, text);
  
  const truncatedResponse = aiResponse.length > 4000 
    ? aiResponse.substring(0, 4000) + "..." 
    : aiResponse;
  
  await msg.reply(truncatedResponse);
});

client.initialize();

// Nettoyage cache
setInterval(() => {
  const now = Date.now();
  for (let [key, value] of responseCache.entries()) {
    if (now - value.timestamp > CACHE_DURATION) {
      responseCache.delete(key);
    }
  }
  console.log('🧹 Cache nettoyé');
}, 10 * 60 * 1000);

// DÉMARRER LE SERVEUR EXPRESS (IMPORTANT POUR RENDER)
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
});

// Gestion propre de l'arrêt
process.on('SIGINT', () => {
  console.log('🛑 Arrêt en cours...');
  client.destroy();
  process.exit();
});